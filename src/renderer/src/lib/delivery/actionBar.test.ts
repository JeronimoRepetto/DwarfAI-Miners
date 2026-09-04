import { describe, expect, it } from 'vitest'
import { defaultDwarf } from '../../testing/factories'
import type { Dwarf } from '../../types'
import {
  buildActionBar,
  CHANNEL_HINT,
  KICK_HINT,
  launchedNoInboxReason,
  NO_CHANNEL_REASON,
  NO_EFFORT_REASON,
  NO_KICK_REASON,
  refusalLine,
  SESSION_ENDED_REASON,
  type ActionBarEntry,
  type ActionId,
  type ActionTransientState
} from './actionBar'

const IDLE: ActionTransientState = { kicking: false, kickArmed: false }

/** A dwarf whose session supports both text delivery and cancellation. */
function capableDwarf(overrides: Partial<Dwarf> = {}): Dwarf {
  return defaultDwarf({
    textDelivery: 'terminal',
    capabilities: { sendText: 'terminal', cancel: 'terminal', adjustEffort: null },
    ...overrides
  })
}

function entryFor(id: ActionId, dwarf: Dwarf, state: ActionTransientState = IDLE): ActionBarEntry {
  const entry = buildActionBar(dwarf, state).find((action) => action.id === id)
  if (!entry) throw new Error(`the bar is missing its "${id}" action`)
  return entry
}

/**
 * The refusal the PANEL shows, rather than the one a hover reveals (#217).
 *
 * Two dead controls with no visible explanation is exactly the "it looks
 * broken" report this comes from: the composer was disabled with no sentence
 * saying why, and the kick's refusal lived only in a tooltip. The reason a
 * disabled control carries is already honest — it just had nowhere on screen
 * to be, so this is what the panel reads to put it there.
 *
 * Chat first, because the composer is the control a person is looking at when
 * they try to say something; the kick's reason surfaces when chat works and
 * the kick does not, which is every ordinary Codex thread (#97).
 */
describe('refusalLine', () => {
  const IDLE_STATE: ActionTransientState = { kicking: false, kickArmed: false }

  it('has nothing to say when both controls work', () => {
    expect(
      refusalLine(
        defaultDwarf({
          textDelivery: 'terminal',
          capabilities: { sendText: 'terminal', cancel: 'terminal', adjustEffort: null }
        }),
        IDLE_STATE
      )
    ).toBeNull()
  })

  it('shows why the composer is disabled, in the panel', () => {
    const dwarf = defaultDwarf({
      provider: 'codex',
      capabilities: { sendText: null, cancel: 'launched-process', adjustEffort: null }
    })
    expect(refusalLine(dwarf, IDLE_STATE)).toBe(launchedNoInboxReason('codex'))
  })

  it("shows the kick's own reason when the composer works and the kick does not", () => {
    const dwarf = defaultDwarf({
      provider: 'codex',
      textDelivery: 'codex-queue',
      capabilities: { sendText: 'codex-queue', cancel: null, adjustEffort: null }
    })
    expect(refusalLine(dwarf, IDLE_STATE)).toBe(KICK_HINT['codex-queue'])
  })

  it('says a session has ended once its agent is gone', () => {
    expect(refusalLine(defaultDwarf({ status: 'leaving' }), IDLE_STATE)).toBe(SESSION_ENDED_REASON)
  })

  /*
   * An in-flight kick is not a refusal: the control is disabled because it is
   * working, and the verdict line is what has something to say about it.
   */
  it('says nothing about a kick that is merely in flight', () => {
    const dwarf = defaultDwarf({
      textDelivery: 'terminal',
      capabilities: { sendText: 'terminal', cancel: 'terminal', adjustEffort: null }
    })
    expect(refusalLine(dwarf, { kicking: true, kickArmed: false })).toBeNull()
  })
})

describe('buildActionBar', () => {
  it('lays out the four actions in fixed order: kick, boost, chat, console', () => {
    const ids = buildActionBar(capableDwarf(), IDLE).map((action) => action.id)
    expect(ids).toEqual(['kick', 'boost', 'chat', 'console'])
  })

  describe('kick', () => {
    it('is enabled with the channel-specific hint when a cancel channel exists', () => {
      const entry = entryFor('kick', capableDwarf())
      expect(entry.enabled).toBe(true)
      expect(entry.name).toBe('Kick')
      expect(entry.hint).toBe('Sends an interrupt keystroke to the session console.')
    })

    it('names the relay-tier limitation honestly', () => {
      const entry = entryFor(
        'kick',
        capableDwarf({
          capabilities: { sendText: 'claude-relay', cancel: 'claude-relay', adjustEffort: null }
        })
      )
      expect(entry.hint).toBe('Asks the agent to stop — it decides how.')
    })

    it('is disabled with a reason when the session has no cancel channel', () => {
      const entry = entryFor(
        'kick',
        capableDwarf({ capabilities: { sendText: null, cancel: null, adjustEffort: null } })
      )
      expect(entry.enabled).toBe(false)
      expect(entry.hint).toBe(NO_KICK_REASON)
    })

    it('is disabled when the dwarf carries no capability matrix at all', () => {
      const entry = entryFor('kick', defaultDwarf())
      expect(entry.enabled).toBe(false)
      expect(entry.hint).toBe(NO_KICK_REASON)
    })

    it('asks for confirmation once armed, staying enabled for the second click', () => {
      const entry = entryFor('kick', capableDwarf(), { kicking: false, kickArmed: true })
      expect(entry.enabled).toBe(true)
      expect(entry.name).toBe('Confirm kick?')
    })

    it('locks and reports progress while a kick is in flight', () => {
      const entry = entryFor('kick', capableDwarf(), { kicking: true, kickArmed: false })
      expect(entry.enabled).toBe(false)
      expect(entry.name).toBe('Kicking...')
    })

    /**
     * A Codex thread's queue delivers messages but drains only between turns,
     * so it can never interrupt one (#97). The generic reason would read as
     * "there is no way into this session at all", which is wrong here — the
     * chat action is enabled on the very same channel — so the disabled kick
     * names the queue's own limit and where a kick does still land.
     */
    it('names the queue limit, not the generic reason, when only the queue can deliver', () => {
      const entry = entryFor(
        'kick',
        capableDwarf({
          textDelivery: 'codex-queue',
          capabilities: { sendText: 'codex-queue', cancel: null, adjustEffort: null }
        })
      )
      expect(entry.enabled).toBe(false)
      expect(entry.hint).not.toBe(NO_KICK_REASON)
      expect(entry.hint).toBe(KICK_HINT['codex-queue'])
      expect(entry.hint).toContain('console')
    })
  })

  describe('boost', () => {
    it('is always disabled in v1: no provider can raise a running session effort', () => {
      const entry = entryFor('boost', capableDwarf())
      expect(entry.enabled).toBe(false)
      expect(entry.name).toBe('Boost')
      expect(entry.hint).toContain(NO_EFFORT_REASON)
    })

    it("names the dwarf's current effort, normalized per provider", () => {
      const entry = entryFor('boost', capableDwarf({ provider: 'claude', effort: 'xhigh' }))
      expect(entry.hint).toContain('Extra high')
    })

    it('passes a codex reasoning_effort value through unchanged', () => {
      const entry = entryFor('boost', capableDwarf({ provider: 'codex', effort: 'medium' }))
      expect(entry.hint).toContain('medium')
    })
  })

  describe('chat', () => {
    it('is enabled with the channel hint when the session can receive text', () => {
      const entry = entryFor('chat', capableDwarf({ textDelivery: 'foreman-relay' }))
      expect(entry.enabled).toBe(true)
      expect(entry.name).toBe('Chat')
      expect(entry.hint).toBe("Delivered to this worker's foreman, tagged for them.")
    })

    it('is disabled with a reason when the session cannot receive text', () => {
      const entry = entryFor('chat', capableDwarf({ textDelivery: undefined }))
      expect(entry.enabled).toBe(false)
      expect(entry.hint).toBe(NO_CHANNEL_REASON)
    })

    /**
     * The queue tier's ✓ means handed to the session's queue and nothing more
     * (#97) — the hint has to say so, because a message read between turns can
     * sit there for seconds after the panel has ticked.
     */
    it('says a queued message waits for the next turn boundary', () => {
      const entry = entryFor('chat', capableDwarf({ textDelivery: 'codex-queue' }))
      expect(entry.enabled).toBe(true)
      expect(entry.hint).toBe(CHANNEL_HINT['codex-queue'])
      expect(entry.hint).toContain('queue')
    })
  })

  /**
   * A 'leaving' dwarf's agent has already finished (#192): its pid is stale
   * and its session name no longer resolves, which is exactly why main refuses
   * to write to one. The bar says so up front, in the same words, rather than
   * offering a channel the session left behind and letting main refuse it.
   */
  describe('ended session', () => {
    it('disables chat with the ended reason, whatever channel the session used to have', () => {
      const entry = entryFor('chat', capableDwarf({ status: 'leaving' }))
      expect(entry.enabled).toBe(false)
      expect(entry.hint).toBe(SESSION_ENDED_REASON)
    })

    it('disables kick with the ended reason: there is nothing left to interrupt', () => {
      const entry = entryFor('kick', capableDwarf({ status: 'leaving' }))
      expect(entry.enabled).toBe(false)
      expect(entry.hint).toBe(SESSION_ENDED_REASON)
    })
  })

  /**
   * A session this panel LAUNCHED and can only end (#217). `codex exec` reads
   * one prompt from stdin and exits with its turn, so there is no inbox to
   * reach — the generic "can't receive messages yet" describes a missing
   * feature, and what this is is the shape of the session. The kick is the
   * opposite of the queue's: it is the only control that works, and it ends
   * the session rather than interrupting a turn.
   */
  describe('launched session', () => {
    function launched(overrides: Partial<Dwarf> = {}): Dwarf {
      return capableDwarf({
        provider: 'codex',
        textDelivery: undefined,
        capabilities: { sendText: null, cancel: 'launched-process', adjustEffort: null },
        ...overrides
      })
    }

    it('disables chat and names the command the session was launched with', () => {
      const entry = entryFor('chat', launched())
      expect(entry.enabled).toBe(false)
      expect(entry.hint).not.toBe(NO_CHANNEL_REASON)
      expect(entry.hint).toContain('codex exec')
      expect(entry.hint).toBe(launchedNoInboxReason('codex'))
    })

    /*
     * Never the wrong CLI's command: the detached shape is the same for both,
     * and a Codex sentence shown for a Claude launch would send somebody to
     * read the wrong program's docs (the #168 mistake, in copy).
     */
    it('names the launch command per provider', () => {
      expect(entryFor('chat', launched({ provider: 'claude' })).hint).toContain('claude -p')
      expect(launchedNoInboxReason('claude')).not.toContain('codex')
    })

    it('offers kick, and says it ends the session rather than interrupting a turn', () => {
      const entry = entryFor('kick', launched())
      expect(entry.enabled).toBe(true)
      expect(entry.hint).toBe(KICK_HINT['launched-process'])
      expect(entry.hint).toContain('Ends the session')
      expect(entry.hint.toLowerCase()).not.toContain('interrupts the turn')
    })
  })

  describe('console', () => {
    it('is always available: focusing the terminal needs no delivery channel', () => {
      const entry = entryFor('console', defaultDwarf())
      expect(entry.enabled).toBe(true)
      expect(entry.name).toBe('Console')
      expect(entry.hint).toBe("Focus this session's console.")
    })
  })
})
