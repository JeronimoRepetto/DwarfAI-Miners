import { describe, expect, it } from 'vitest'
import { defaultDwarf } from '../../testing/factories'
import type { Dwarf } from '../../types'
import {
  buildActionBar,
  NO_CHANNEL_REASON,
  NO_EFFORT_REASON,
  NO_KICK_REASON,
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
