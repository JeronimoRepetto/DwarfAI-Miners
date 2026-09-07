import { describe, expect, it } from 'vitest'
import { SESSION_ENDED_REASON } from '../delivery/actionBar'
import { defaultDwarf } from '../../testing/factories'
import type { Dwarf } from '../../types'
import { MCP_STATUS_LABEL, NO_SESSION_SURFACE_REASON, sessionStrip } from './sessionStrip'

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

  it('refuses, with the reason, for a session this panel only observes', () => {
    const observed = defaultDwarf({ textDelivery: 'terminal' })
    expect(sessionStrip(observed)).toEqual({
      kind: 'unavailable',
      reason: NO_SESSION_SURFACE_REASON
    })
  })

  it('refuses for a session with no channel at all, rather than drawing an empty strip', () => {
    expect(sessionStrip(defaultDwarf())).toEqual({
      kind: 'unavailable',
      reason: NO_SESSION_SURFACE_REASON
    })
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
