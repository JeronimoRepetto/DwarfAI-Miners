import { describe, expect, it } from 'vitest'
import { SESSION_ENDED_REASON } from '../delivery/actionBar'
import { defaultDwarf } from '../../testing/factories'
import type { AgentModelCatalog, Dwarf } from '../../types'
import {
  MCP_STATUS_LABEL,
  NO_EFFORT_CONTROL_REASON,
  NO_MODEL_CONTROL_REASON,
  sessionStrip
} from './sessionStrip'

/**
 * Issue #96, the read-only command surface, in the mine view.
 *
 * The model behind the strip: what a session says about itself that this app
 * can actually PROVE — the model in force, how much of its context window is
 * spent, and every MCP server it has with the CLI's own connection state. The
 * whole point of putting it in a pure module is that "which sessions can even
 * answer this" is one decision with a test on it, rather than a `v-if` in a
 * component.
 */

/** A dwarf whose session this panel is HOLDING, which is the only kind that reports any of this. */
function heldDwarf(overrides: Partial<Dwarf> = {}): Dwarf {
  return defaultDwarf({
    id: 'claude:sess-1',
    role: 'foreman',
    textDelivery: 'held-session',
    model: 'claude-haiku-4-5',
    ...overrides
  })
}

describe('sessionStrip', () => {
  it('draws nothing at all when no dwarf is selected', () => {
    // An empty frame would read as a session reporting nothing, which is a
    // different claim from there being no session to report on.
    expect(sessionStrip(undefined)).toEqual({ kind: 'none' })
  })

  it('draws no strip at all for a session this panel only observes (#295)', () => {
    // AMENDED for #295 (was: "refuses, with the reason, for a session this
    // panel only observes", expecting `{ kind: 'unavailable', reason:
    // NO_SESSION_SURFACE_REASON }`). The maintainer reversed the disabled
    // reading: the sentence repeated on every observed dwarf and told the
    // reader nothing they could act on, so this session now draws no strip
    // rather than a control that quietly does nothing.
    const observed = defaultDwarf({ textDelivery: 'terminal' })
    expect(sessionStrip(observed)).toEqual({ kind: 'none' })
  })

  it('draws no strip for a session with no channel at all, same as one this panel observes (#295)', () => {
    // AMENDED for #295 (was: "refuses for a session with no channel at all,
    // rather than drawing an empty strip"). No delivery channel is not held
    // either, so it now reads the same as any other session this panel does
    // not hold: nothing drawn.
    expect(sessionStrip(defaultDwarf())).toEqual({ kind: 'none' })
  })

  it('refuses for a held session that has already ended, in the action bar’s own words', () => {
    // The grace window freezes the last real snapshot, delivery channel and
    // all — so the channel still reads `held-session` for a session the
    // registry has already let go of. The bar reads the STATUS for exactly
    // this reason, and so does this.
    expect(sessionStrip(heldDwarf({ status: 'leaving' }))).toEqual({
      kind: 'unavailable',
      reason: SESSION_ENDED_REASON
    })
  })

  it('reports the model in force for a held session', () => {
    const strip = sessionStrip(heldDwarf())
    expect(strip).toMatchObject({ kind: 'live', model: 'claude-haiku-4-5' })
  })

  it('leaves the model out while the session has yet to name one', () => {
    const strip = sessionStrip(heldDwarf({ model: undefined }))
    expect(strip.kind).toBe('live')
    expect(strip.kind === 'live' && 'model' in strip).toBe(false)
  })

  it('reads the context window as used over max, compactly, with a bar to match', () => {
    const strip = sessionStrip(
      heldDwarf({ contextUsage: { usedTokens: 41_237, maxTokens: 200_000 } })
    )
    expect(strip.kind === 'live' && strip.context).toEqual({
      usedTokens: 41_237,
      maxTokens: 200_000,
      label: '41.2K / 200K',
      percent: 21,
      detail: '41237 of 200000 tokens (21%)'
    })
  })

  it('draws a full bar for a session past its own window rather than one past 100%', () => {
    // The wire reports what the CLI said, unclamped on purpose; a bar wider
    // than its track is the renderer's problem and it is solved here.
    const strip = sessionStrip(
      heldDwarf({ contextUsage: { usedTokens: 260_000, maxTokens: 200_000 } })
    )
    expect(strip.kind === 'live' && strip.context?.percent).toBe(100)
    expect(strip.kind === 'live' && strip.context?.label).toBe('260K / 200K')
  })

  it('reads an untouched context window as an empty bar, never as a missing one', () => {
    const strip = sessionStrip(heldDwarf({ contextUsage: { usedTokens: 0, maxTokens: 200_000 } }))
    expect(strip.kind === 'live' && strip.context?.percent).toBe(0)
    expect(strip.kind === 'live' && strip.context?.label).toBe('0 / 200K')
  })

  it('leaves the context out entirely until a reading has actually arrived', () => {
    // `0 / 0` would be this app claiming a measurement it never took.
    const strip = sessionStrip(heldDwarf())
    expect(strip.kind).toBe('live')
    expect(strip.kind === 'live' && strip.context).toBeUndefined()
  })

  it("keeps the MCP roster in the CLI's own order, needs-auth included", () => {
    // Issue #96's live-fire spike found three of seven servers resting in
    // `needs-auth`: that is a normal state for a proxy server, not an error,
    // so nothing here filters it out or reorders around it.
    const strip = sessionStrip(
      heldDwarf({
        mcpServers: [
          { name: 'codegraph', status: 'connected' },
          { name: 'claude-ai-gmail', status: 'needs-auth' },
          { name: 'engram', status: 'connected' }
        ]
      })
    )
    expect(strip.kind === 'live' && strip.mcpServers).toEqual([
      { name: 'codegraph', status: 'connected' },
      { name: 'claude-ai-gmail', status: 'needs-auth' },
      { name: 'engram', status: 'connected' }
    ])
  })

  it('reads a held session with no servers configured as an empty roster', () => {
    const strip = sessionStrip(heldDwarf())
    expect(strip.kind === 'live' && strip.mcpServers).toEqual([])
  })
})

/*
 * Issue #96's MUTATING slice, and the whole of "which controls exist for
 * which state" — the decision this module exists to keep out of the
 * component's `v-if` ladder.
 *
 * Two rules do most of the work, both the maintainer's:
 *
 * 1. A model select is offered only from a catalogue asked LIVE
 *    (`source: 'provider'`). A `history` or `none` answer is not a list of
 *    what a session may switch to, so the strip draws the plain name instead
 *    of a choice built from a guess.
 * 2. An effort select exists only where the ACTIVE model's own catalogue
 *    entry names effort levels — and where it does not, there is NO control
 *    at all rather than a disabled one, because `applyFlagSettings` accepts
 *    the request and silently does nothing. A disabled control says "not
 *    right now"; the truth is "this model has no such setting".
 */
const CLAUDE_LIVE: AgentModelCatalog = {
  provider: 'claude',
  models: [
    { value: 'claude-haiku-4-5', label: 'Haiku' },
    {
      value: 'claude-sonnet-5',
      label: 'Sonnet',
      effortLevels: ['low', 'medium', 'high']
    }
  ],
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  source: 'provider'
}

/** A held dwarf whose engine offers both acts, which is a held Claude session. */
function tunableDwarf(overrides: Partial<Dwarf> = {}): Dwarf {
  return heldDwarf({
    sessionTuning: { canSetModel: true, canSetEffort: true },
    ...overrides
  })
}

describe('sessionStrip controls (#96)', () => {
  it('offers the live catalogue as the model select, showing what the session runs', () => {
    const strip = sessionStrip(tunableDwarf(), [CLAUDE_LIVE])
    expect(strip.kind === 'live' && strip.modelControl).toEqual({
      value: 'claude-haiku-4-5',
      options: [
        { value: 'claude-haiku-4-5', label: 'Haiku' },
        { value: 'claude-sonnet-5', label: 'Sonnet' }
      ]
    })
  })

  it('falls back to the value itself for an option the provider gave no name', () => {
    const strip = sessionStrip(tunableDwarf(), [
      { ...CLAUDE_LIVE, models: [{ value: 'claude-haiku-4-5' }] }
    ])
    expect(strip.kind === 'live' && strip.modelControl?.options).toEqual([
      { value: 'claude-haiku-4-5', label: 'claude-haiku-4-5' }
    ])
  })

  it('reads the catalogue of the provider this dwarf actually runs, never the first one', () => {
    const codex: AgentModelCatalog = {
      provider: 'codex',
      models: [{ value: 'gpt-5' }],
      efforts: [],
      source: 'history'
    }
    const strip = sessionStrip(tunableDwarf(), [codex, CLAUDE_LIVE])
    expect(strip.kind === 'live' && strip.modelControl?.options.map((o) => o.value)).toEqual([
      'claude-haiku-4-5',
      'claude-sonnet-5'
    ])
  })

  it('offers no model select at all from a catalogue nobody asked live', () => {
    // `history` is what this machine happens to have used and `none` is
    // nothing to offer — neither is a list of what a session may switch TO,
    // so the strip shows the model as plain text rather than as a choice.
    for (const source of ['history', 'none'] as const) {
      const strip = sessionStrip(tunableDwarf(), [{ ...CLAUDE_LIVE, source }])
      expect(strip.kind === 'live' && strip.modelControl).toBeUndefined()
      expect(strip.kind === 'live' && strip.model).toBe('claude-haiku-4-5')
    }
  })

  it('offers no model select when the catalogue has not been answered yet', () => {
    const strip = sessionStrip(tunableDwarf(), [])
    expect(strip.kind === 'live' && strip.modelControl).toBeUndefined()
  })

  it('offers no model select from a live catalogue that named no models', () => {
    const strip = sessionStrip(tunableDwarf(), [{ ...CLAUDE_LIVE, models: [] }])
    expect(strip.kind === 'live' && strip.modelControl).toBeUndefined()
  })

  it('disables the model select, with its reason, for an engine that has no such act', () => {
    // A held session on an engine with no mid-run model change. Drawn and
    // disabled rather than hidden: the same idiom the dwarf action bar holds
    // for an action a session type cannot serve.
    const strip = sessionStrip(
      tunableDwarf({ sessionTuning: { canSetModel: false, canSetEffort: false } }),
      [CLAUDE_LIVE]
    )
    expect(strip.kind === 'live' && strip.modelControl?.disabledReason).toBe(
      NO_MODEL_CONTROL_REASON
    )
    expect(strip.kind === 'live' && strip.modelControl?.value).toBe('claude-haiku-4-5')
  })

  it('offers no control at all for a held session that has reported no tuning yet', () => {
    // Absence on the wire is "no control here", never "assume it works".
    const strip = sessionStrip(heldDwarf(), [CLAUDE_LIVE])
    expect(strip.kind === 'live' && strip.modelControl).toBeUndefined()
    expect(strip.kind === 'live' && strip.effortControl).toBeUndefined()
  })

  it('words a model change nothing has confirmed as pending, keeping the old one legible', () => {
    // The verification rule, drawn: the select still reads what the session
    // actually runs, and the requested value is stated beside it as pending.
    const strip = sessionStrip(
      tunableDwarf({
        sessionTuning: {
          canSetModel: true,
          canSetEffort: true,
          pendingModel: 'claude-sonnet-5'
        }
      }),
      [CLAUDE_LIVE]
    )
    expect(strip.kind === 'live' && strip.modelControl?.value).toBe('claude-haiku-4-5')
    expect(strip.kind === 'live' && strip.modelControl?.pendingNote).toBe('claude-sonnet-5 pending')
  })

  it('offers no effort select for an active model that takes no effort', () => {
    // NOT a disabled one. `applyFlagSettings` accepts the request and does
    // nothing, so a control here would answer a click by reporting success
    // and changing nothing — the one failure this rule exists to prevent.
    const strip = sessionStrip(tunableDwarf({ model: 'claude-haiku-4-5' }), [CLAUDE_LIVE])
    expect(strip.kind === 'live' && strip.effortControl).toBeUndefined()
  })

  it("offers the active model's own effort levels, never the provider's whole set", () => {
    const strip = sessionStrip(tunableDwarf({ model: 'claude-sonnet-5' }), [CLAUDE_LIVE])
    expect(strip.kind === 'live' && strip.effortControl?.options).toEqual([
      { value: 'low', label: 'low' },
      { value: 'medium', label: 'medium' },
      { value: 'high', label: 'high' }
    ])
  })

  it('shows the effort the session reported as the control’s own value', () => {
    const strip = sessionStrip(tunableDwarf({ model: 'claude-sonnet-5', effort: 'medium' }), [
      CLAUDE_LIVE
    ])
    expect(strip.kind === 'live' && strip.effortControl?.value).toBe('medium')
  })

  it('offers no effort select for a model the live catalogue does not list', () => {
    // Nothing said this model takes an effort, so nothing here claims it does.
    const strip = sessionStrip(tunableDwarf({ model: 'claude-opus-5' }), [CLAUDE_LIVE])
    expect(strip.kind === 'live' && strip.effortControl).toBeUndefined()
  })

  it('offers no effort select while the session has yet to name a model', () => {
    // Which levels apply is a fact about the ACTIVE model, and there is no
    // active model to read it off yet.
    const strip = sessionStrip(tunableDwarf({ model: undefined }), [CLAUDE_LIVE])
    expect(strip.kind === 'live' && strip.effortControl).toBeUndefined()
  })

  it('words an effort change as REQUESTED rather than pending, because nothing may confirm it', () => {
    // The honest word. A model change has a reading that proves it; an effort
    // change has only the next turn's `init`, which may never say anything.
    const strip = sessionStrip(
      tunableDwarf({
        model: 'claude-sonnet-5',
        sessionTuning: { canSetModel: true, canSetEffort: true, pendingEffort: 'high' }
      }),
      [CLAUDE_LIVE]
    )
    expect(strip.kind === 'live' && strip.effortControl?.pendingNote).toBe('high requested')
  })

  it('disables the effort select, with its reason, for an engine that has no such act', () => {
    const strip = sessionStrip(
      tunableDwarf({
        model: 'claude-sonnet-5',
        sessionTuning: { canSetModel: true, canSetEffort: false }
      }),
      [CLAUDE_LIVE]
    )
    expect(strip.kind === 'live' && strip.effortControl?.disabledReason).toBe(
      NO_EFFORT_CONTROL_REASON
    )
  })

  it('offers no control whatsoever on a strip that draws nothing or is refusing (#295)', () => {
    // AMENDED for #295: a session this panel only observes now draws no
    // strip at all, live catalogue supplied or not — there is no control
    // standing there to disable. A held session whose stream has ended is
    // still a refusal, exactly as the read-only half already is.
    const observed = sessionStrip(defaultDwarf({ textDelivery: 'terminal' }), [CLAUDE_LIVE])
    expect(observed).toEqual({ kind: 'none' })
    const ended = sessionStrip(tunableDwarf({ status: 'leaving' }), [CLAUDE_LIVE])
    expect(ended).toEqual({ kind: 'unavailable', reason: SESSION_ENDED_REASON })
  })
})

describe('MCP_STATUS_LABEL', () => {
  it('names every member of the SDK’s closed status enum', () => {
    expect(Object.keys(MCP_STATUS_LABEL).sort()).toEqual([
      'connected',
      'disabled',
      'failed',
      'needs-auth',
      'pending'
    ])
  })

  it('never words needs-auth as a failure, because it is a resting state', () => {
    // The one wording rule the maintainer stated outright for this surface.
    expect(MCP_STATUS_LABEL['needs-auth'].toLowerCase()).not.toContain('fail')
    expect(MCP_STATUS_LABEL['needs-auth'].toLowerCase()).not.toContain('error')
  })
})
