// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REACTION_WINDOW_MS } from '../lib/reaction'
import { defaultDwarf } from '../testing/factories'
import type { Dwarf, DwarfKickResult } from '../types'
import { RESULT_VISIBLE_MS, useDwarfKicking } from './useDwarfKicking'

/** Main's record of "this agent was seen stopping" (#46); asserted on below. */
const retireDwarf = vi.fn()

function stubApi(kickDwarf: (...args: never[]) => Promise<DwarfKickResult>): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { kickDwarf, retireDwarf }
  })
}

/** Resolves only when `release()` is called, so a pending state can be observed. */
function deferred<T>() {
  let release!: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

describe('useDwarfKicking', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useDwarfKicking().clearAll()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('marks the dwarf as kicking until the verdict arrives', async () => {
    const pending = deferred<DwarfKickResult>()
    stubApi(() => pending.promise)
    const { kick, stateFor } = useDwarfKicking()

    const kicking = kick('claude:s1')
    expect(stateFor('claude:s1')).toEqual({ phase: 'kicking' })

    pending.release({ delivered: true, via: 'terminal' })
    await kicking
    // Delivered means the interrupt was handed over — not that the session
    // stopped. The store starts watching for the proof.
    expect(stateFor('claude:s1')).toEqual({
      phase: 'delivered',
      via: 'terminal',
      awaitingReaction: true
    })
  })

  it('keeps the failure reason so the panel can explain itself', async () => {
    stubApi(() =>
      Promise.resolve({
        delivered: false,
        via: 'terminal',
        error: 'The agent terminal could not be reached.'
      })
    )
    const { kick, stateFor } = useDwarfKicking()

    await kick('claude:s1')
    expect(stateFor('claude:s1')).toEqual({
      phase: 'failed',
      via: 'terminal',
      error: 'The agent terminal could not be reached.'
    })
  })

  it('turns a broken IPC call into a failed state rather than an unhandled rejection', async () => {
    stubApi(() => Promise.reject(new Error('bridge is gone')))
    const { kick, stateFor } = useDwarfKicking()

    await kick('claude:s1')
    expect(stateFor('claude:s1')?.phase).toBe('failed')
    expect(stateFor('claude:s1')?.error).toBeTruthy()
  })

  it('clears a failed verdict after it has been on screen long enough to read', async () => {
    stubApi(() => Promise.resolve({ delivered: false, via: 'terminal', error: 'nope' }))
    const { kick, stateFor } = useDwarfKicking()

    await kick('claude:s1')
    expect(stateFor('claude:s1')?.phase).toBe('failed')

    vi.advanceTimersByTime(RESULT_VISIBLE_MS)
    expect(stateFor('claude:s1')).toBeUndefined()
  })

  it('ignores a second kick while the first is still in flight', async () => {
    const pending = deferred<DwarfKickResult>()
    const api = vi.fn().mockReturnValue(pending.promise)
    stubApi(api as never)
    const { kick } = useDwarfKicking()

    const first = kick('claude:s1')
    await kick('claude:s1')
    expect(api).toHaveBeenCalledTimes(1)

    pending.release({ delivered: true, via: 'terminal' })
    await first
  })

  it('tracks each dwarf separately', async () => {
    stubApi(() => Promise.resolve({ delivered: true, via: 'terminal' }))
    const { kick, stateFor } = useDwarfKicking()

    await kick('claude:s1')
    expect(stateFor('claude:s1')?.phase).toBe('delivered')
    expect(stateFor('claude:s2')).toBeUndefined()
  })

  it('passes the dwarf id straight through to the main process', async () => {
    const api = vi.fn().mockResolvedValue({ delivered: true, via: 'terminal' })
    stubApi(api as never)
    const { kick } = useDwarfKicking()

    await kick('claude:s1')
    expect(api).toHaveBeenCalledWith({ dwarfId: 'claude:s1' })
  })
})

/**
 * A kick asks a session to stop; the proof is that it stopped. Everything here
 * is driven by the snapshots the panel already polls — no new IPC.
 */
describe('useDwarfKicking reaction tracking', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useDwarfKicking().clearAll()
    retireDwarf.mockClear()
    stubApi(() => Promise.resolve({ delivered: true, via: 'claude-relay' }))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function dwarf(overrides: Partial<Dwarf> = {}): Dwarf {
    return defaultDwarf({ id: 'claude:s1', ...overrides })
  }

  it('keeps the delivered marker on screen while it is still watching', async () => {
    const { kick, observe, stateFor } = useDwarfKicking()
    observe([dwarf({ status: 'working' })])
    await kick('claude:s1')

    vi.advanceTimersByTime(RESULT_VISIBLE_MS)
    expect(stateFor('claude:s1')).toMatchObject({ phase: 'delivered', awaitingReaction: true })
  })

  it('promotes to reacted when the session is seen stopping', async () => {
    const { kick, observe, stateFor } = useDwarfKicking()
    observe([dwarf({ status: 'working' })])
    await kick('claude:s1')

    observe([dwarf({ status: 'waiting' })])
    expect(stateFor('claude:s1')).toMatchObject({ phase: 'reacted', via: 'claude-relay' })
  })

  it('stays delivered while the session keeps working', async () => {
    const { kick, observe, stateFor } = useDwarfKicking()
    observe([dwarf({ status: 'working' })])
    await kick('claude:s1')

    observe([dwarf({ status: 'working' })])
    expect(stateFor('claude:s1')?.phase).toBe('delivered')
  })

  it('never claims credit for a session that simply left', async () => {
    const { kick, observe, stateFor } = useDwarfKicking()
    observe([dwarf({ status: 'working' })])
    await kick('claude:s1')

    observe([dwarf({ status: 'leaving' })])
    expect(stateFor('claude:s1')?.phase).toBe('delivered')
  })

  it('waits for the full round trip when the session was already idle', async () => {
    const { kick, observe, stateFor } = useDwarfKicking()
    observe([dwarf({ status: 'waiting' })])
    await kick('claude:s1')

    observe([dwarf({ status: 'waiting' })])
    expect(stateFor('claude:s1')?.phase).toBe('delivered')

    observe([dwarf({ status: 'working' })])
    expect(stateFor('claude:s1')?.phase).toBe('delivered')

    observe([dwarf({ status: 'waiting' })])
    expect(stateFor('claude:s1')?.phase).toBe('reacted')
  })

  it('never reads another dwarf as this one reacting', async () => {
    const { kick, observe, stateFor } = useDwarfKicking()
    observe([dwarf({ status: 'working' })])
    await kick('claude:s1')

    observe([dwarf({ status: 'working' }), defaultDwarf({ id: 'claude:s2', status: 'waiting' })])
    expect(stateFor('claude:s1')?.phase).toBe('delivered')
  })

  it('decays to a plain delivered verdict when no reaction is ever seen', async () => {
    const { kick, observe, stateFor } = useDwarfKicking()
    observe([dwarf({ status: 'working' })])
    await kick('claude:s1')

    vi.advanceTimersByTime(REACTION_WINDOW_MS)
    expect(stateFor('claude:s1')).toMatchObject({ phase: 'delivered', awaitingReaction: false })

    vi.advanceTimersByTime(RESULT_VISIBLE_MS)
    expect(stateFor('claude:s1')).toBeUndefined()
  })

  it('clears the reacted marker once it has been read', async () => {
    const { kick, observe, stateFor } = useDwarfKicking()
    observe([dwarf({ status: 'working' })])
    await kick('claude:s1')

    observe([dwarf({ status: 'waiting' })])
    expect(stateFor('claude:s1')?.phase).toBe('reacted')

    vi.advanceTimersByTime(RESULT_VISIBLE_MS)
    expect(stateFor('claude:s1')).toBeUndefined()
  })

  it('never promotes a kick that failed', async () => {
    stubApi(() => Promise.resolve({ delivered: false, via: 'terminal', error: 'nope' }))
    const { kick, observe, stateFor } = useDwarfKicking()
    observe([dwarf({ status: 'working' })])
    await kick('claude:s1')

    observe([dwarf({ status: 'waiting' })])
    expect(stateFor('claude:s1')?.phase).toBe('failed')
  })

  it('survives a poll that arrives before anything was ever kicked', () => {
    const { observe } = useDwarfKicking()
    expect(() => observe([dwarf()])).not.toThrow()
  })
})

/**
 * Retiring the dwarf (issue #46). The trigger is the SAME observation that
 * earns the ✓✓ and nothing weaker: main is told only once an agent has been
 * seen stopping, never when the interrupt was merely handed over.
 */
describe('useDwarfKicking retirement', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useDwarfKicking().clearAll()
    retireDwarf.mockClear()
    stubApi(() => Promise.resolve({ delivered: true, via: 'claude-relay' }))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function dwarf(overrides: Partial<Dwarf> = {}): Dwarf {
    return defaultDwarf({ id: 'claude:s1', ...overrides })
  }

  it('asks main to retire the dwarf once its agent is seen stopping', async () => {
    const { kick, observe } = useDwarfKicking()
    observe([dwarf({ status: 'working' })])
    await kick('claude:s1')

    observe([dwarf({ status: 'waiting' })])
    expect(retireDwarf).toHaveBeenCalledWith('claude:s1')
  })

  it('never retires a kick that was only ever handed over', async () => {
    const { kick, observe } = useDwarfKicking()
    observe([dwarf({ status: 'working' })])
    await kick('claude:s1')

    // Still working when the window closes: better a ghost than a lie.
    observe([dwarf({ status: 'working' })])
    vi.advanceTimersByTime(REACTION_WINDOW_MS)
    expect(retireDwarf).not.toHaveBeenCalled()
  })

  it('never retires a dwarf that merely left', async () => {
    const { kick, observe } = useDwarfKicking()
    observe([dwarf({ status: 'working' })])
    await kick('claude:s1')

    // A vanished agent is as consistent with a crash as with the kick landing.
    observe([dwarf({ status: 'leaving' })])
    expect(retireDwarf).not.toHaveBeenCalled()
  })

  it('never retires when the kick itself failed', async () => {
    stubApi(() => Promise.resolve({ delivered: false, via: 'terminal', error: 'nope' }))
    const { kick, observe } = useDwarfKicking()
    observe([dwarf({ status: 'working' })])
    await kick('claude:s1')

    observe([dwarf({ status: 'waiting' })])
    expect(retireDwarf).not.toHaveBeenCalled()
  })

  it('never reads another dwarf stopping as this one being retired', async () => {
    const { kick, observe } = useDwarfKicking()
    observe([dwarf({ status: 'working' })])
    await kick('claude:s1')

    observe([dwarf({ status: 'working' }), defaultDwarf({ id: 'claude:s2', status: 'waiting' })])
    expect(retireDwarf).not.toHaveBeenCalled()
  })

  it('retires the dwarf exactly once however many polls follow', async () => {
    const { kick, observe } = useDwarfKicking()
    observe([dwarf({ status: 'working' })])
    await kick('claude:s1')

    observe([dwarf({ status: 'waiting' })])
    observe([dwarf({ status: 'waiting' })])
    observe([dwarf({ status: 'waiting' })])
    expect(retireDwarf).toHaveBeenCalledTimes(1)
  })
})
