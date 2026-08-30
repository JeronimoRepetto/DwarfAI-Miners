// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REACTION_WINDOW_MS } from '../lib/delivery/reaction'
import { defaultDwarf } from '../testing/factories'
import type { Dwarf, DwarfTextResult } from '../types'
import { RESULT_VISIBLE_MS, useDwarfMessaging } from './useDwarfMessaging'

function stubApi(sendDwarfText: (...args: never[]) => Promise<DwarfTextResult>): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { sendDwarfText }
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

describe('useDwarfMessaging', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useDwarfMessaging().clearAll()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('marks the dwarf as sending until the delivery verdict arrives', async () => {
    const pending = deferred<DwarfTextResult>()
    stubApi(() => pending.promise)
    const { send, stateFor } = useDwarfMessaging()

    const sending = send('claude:s1', 'run the tests', true)
    expect(stateFor('claude:s1')).toEqual({ phase: 'sending' })

    pending.release({ delivered: true, via: 'terminal' })
    await sending
    // Delivered means handed to the session's queue — the store immediately
    // starts watching for proof the session actually read it.
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
        error: 'The terminal would not come forward.'
      })
    )
    const { send, stateFor } = useDwarfMessaging()

    await send('claude:s1', 'hi', true)
    expect(stateFor('claude:s1')).toEqual({
      phase: 'failed',
      via: 'terminal',
      error: 'The terminal would not come forward.'
    })
  })

  it('turns a broken IPC call into a failed state rather than an unhandled rejection', async () => {
    stubApi(() => Promise.reject(new Error('bridge is gone')))
    const { send, stateFor } = useDwarfMessaging()

    await send('claude:s1', 'hi', true)
    expect(stateFor('claude:s1')?.phase).toBe('failed')
    expect(stateFor('claude:s1')?.error).toBeTruthy()
  })

  it('clears a failed verdict after it has been on screen long enough to read', async () => {
    stubApi(() => Promise.resolve({ delivered: false, via: 'terminal', error: 'nope' }))
    const { send, stateFor } = useDwarfMessaging()

    await send('claude:s1', 'hi', true)
    expect(stateFor('claude:s1')?.phase).toBe('failed')

    vi.advanceTimersByTime(RESULT_VISIBLE_MS)
    expect(stateFor('claude:s1')).toBeUndefined()
  })

  it('ignores a second send while the first is still in flight', async () => {
    const pending = deferred<DwarfTextResult>()
    const api = vi.fn().mockReturnValue(pending.promise)
    stubApi(api as never)
    const { send } = useDwarfMessaging()

    const first = send('claude:s1', 'one', true)
    await send('claude:s1', 'two', true)
    expect(api).toHaveBeenCalledTimes(1)

    pending.release({ delivered: true, via: 'terminal' })
    await first
  })

  it('tracks each dwarf separately', async () => {
    stubApi(() => Promise.resolve({ delivered: true, via: 'terminal' }))
    const { send, stateFor } = useDwarfMessaging()

    await send('claude:s1', 'hi', true)
    expect(stateFor('claude:s1')?.phase).toBe('delivered')
    expect(stateFor('claude:s2')).toBeUndefined()
  })

  it('passes the Enter preference straight through to the main process', async () => {
    const api = vi.fn().mockResolvedValue({ delivered: true, via: 'terminal' })
    stubApi(api as never)
    const { send } = useDwarfMessaging()

    await send('claude:s1', 'hi', false)
    expect(api).toHaveBeenCalledWith({ dwarfId: 'claude:s1', text: 'hi', pressEnter: false })
  })
})

/**
 * The second phase of the verdict. The store is fed the same per-poll snapshots
 * the panel already renders, so proving a session reacted costs no new IPC.
 */
describe('useDwarfMessaging reaction tracking', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useDwarfMessaging().clearAll()
    stubApi(() => Promise.resolve({ delivered: true, via: 'claude-relay' }))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function dwarf(overrides: Partial<Dwarf> = {}): Dwarf {
    return defaultDwarf({ id: 'claude:s1', ...overrides })
  }

  it('keeps the delivered marker on screen while it is still watching', async () => {
    const { send, observe, stateFor } = useDwarfMessaging()
    observe([dwarf({ status: 'working', lastMessage: 'a' })])
    await send('claude:s1', 'hi', true)

    vi.advanceTimersByTime(RESULT_VISIBLE_MS)
    expect(stateFor('claude:s1')).toMatchObject({ phase: 'delivered', awaitingReaction: true })
  })

  it('promotes to reacted when the session answers with a new message', async () => {
    const { send, observe, stateFor } = useDwarfMessaging()
    observe([dwarf({ status: 'working', lastMessage: 'a' })])
    await send('claude:s1', 'hi', true)

    observe([dwarf({ status: 'working', lastMessage: 'on it' })])
    expect(stateFor('claude:s1')).toMatchObject({ phase: 'reacted', via: 'claude-relay' })
  })

  it('promotes when an idle session picks the message up', async () => {
    const { send, observe, stateFor } = useDwarfMessaging()
    observe([dwarf({ status: 'waiting', lastMessage: 'a' })])
    await send('claude:s1', 'hi', true)

    observe([dwarf({ status: 'working', lastMessage: 'a' })])
    expect(stateFor('claude:s1')?.phase).toBe('reacted')
  })

  it('compares against the snapshot from before the send, not the one after', async () => {
    const { send, observe, stateFor } = useDwarfMessaging()
    observe([dwarf({ status: 'working', lastMessage: 'a' })])
    await send('claude:s1', 'hi', true)

    observe([dwarf({ status: 'working', lastMessage: 'a' })])
    expect(stateFor('claude:s1')?.phase).toBe('delivered')
  })

  it('never reads another dwarf as this one reacting', async () => {
    const { send, observe, stateFor } = useDwarfMessaging()
    observe([dwarf({ status: 'working', lastMessage: 'a' })])
    await send('claude:s1', 'hi', true)

    observe([
      dwarf({ status: 'working', lastMessage: 'a' }),
      defaultDwarf({ id: 'claude:s2', status: 'working', lastMessage: 'busy over here' })
    ])
    expect(stateFor('claude:s1')?.phase).toBe('delivered')
  })

  it('decays to a plain delivered verdict when no reaction is ever seen', async () => {
    const { send, observe, stateFor } = useDwarfMessaging()
    observe([dwarf({ status: 'working', lastMessage: 'a' })])
    await send('claude:s1', 'hi', true)

    vi.advanceTimersByTime(REACTION_WINDOW_MS)
    expect(stateFor('claude:s1')).toMatchObject({ phase: 'delivered', awaitingReaction: false })

    vi.advanceTimersByTime(RESULT_VISIBLE_MS)
    expect(stateFor('claude:s1')).toBeUndefined()
  })

  it('never promotes after the window has closed', async () => {
    const { send, observe, stateFor } = useDwarfMessaging()
    observe([dwarf({ status: 'working', lastMessage: 'a' })])
    await send('claude:s1', 'hi', true)

    vi.advanceTimersByTime(REACTION_WINDOW_MS)
    observe([dwarf({ status: 'working', lastMessage: 'far too late' })])
    expect(stateFor('claude:s1')?.phase).toBe('delivered')
  })

  it('clears the reacted marker once it has been read', async () => {
    const { send, observe, stateFor } = useDwarfMessaging()
    observe([dwarf({ status: 'working', lastMessage: 'a' })])
    await send('claude:s1', 'hi', true)

    observe([dwarf({ status: 'working', lastMessage: 'b' })])
    expect(stateFor('claude:s1')?.phase).toBe('reacted')

    vi.advanceTimersByTime(RESULT_VISIBLE_MS)
    expect(stateFor('claude:s1')).toBeUndefined()
  })

  it('never promotes a delivery that failed', async () => {
    stubApi(() => Promise.resolve({ delivered: false, via: 'terminal', error: 'nope' }))
    const { send, observe, stateFor } = useDwarfMessaging()
    observe([dwarf({ status: 'working', lastMessage: 'a' })])
    await send('claude:s1', 'hi', true)

    observe([dwarf({ status: 'working', lastMessage: 'b' })])
    expect(stateFor('claude:s1')?.phase).toBe('failed')
  })

  it('watches the newest send rather than an older one', async () => {
    const { send, observe, stateFor } = useDwarfMessaging()
    observe([dwarf({ status: 'working', lastMessage: 'a' })])
    await send('claude:s1', 'first', true)
    observe([dwarf({ status: 'working', lastMessage: 'b' })])
    expect(stateFor('claude:s1')?.phase).toBe('reacted')

    await send('claude:s1', 'second', true)
    expect(stateFor('claude:s1')?.phase).toBe('delivered')

    observe([dwarf({ status: 'working', lastMessage: 'b' })])
    expect(stateFor('claude:s1')?.phase).toBe('delivered')

    observe([dwarf({ status: 'working', lastMessage: 'c' })])
    expect(stateFor('claude:s1')?.phase).toBe('reacted')
  })

  it('survives a poll that arrives before anything was ever sent', () => {
    const { observe } = useDwarfMessaging()
    expect(() => observe([dwarf()])).not.toThrow()
  })
})
