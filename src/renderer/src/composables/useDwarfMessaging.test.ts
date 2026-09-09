// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REACTION_WINDOW_MS } from '../lib/delivery/reaction'
import { ECHO_LIMIT } from '../lib/message/echo'
import { defaultDwarf } from '../testing/factories'
import type { Dwarf, DwarfTextResult, FeedMessage } from '../types'
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

  /*
   * Issue #183: App's own feed watch re-reads on a delivered send, and it can
   * only do that off what `send` itself resolves to — the store's internal
   * `state.byDwarfId` is keyed by dwarf id and a caller has no business poking
   * through it to learn the verdict of the call it just made.
   */
  it('resolves true when the delivery landed, so a caller can react to it (#183)', async () => {
    stubApi(() => Promise.resolve({ delivered: true, via: 'terminal' }))
    const { send } = useDwarfMessaging()
    await expect(send('claude:s1', 'hi', true)).resolves.toBe(true)
  })

  it('resolves false when the delivery failed', async () => {
    stubApi(() =>
      Promise.resolve({
        delivered: false,
        via: 'terminal',
        error: 'The terminal would not come forward.'
      })
    )
    const { send } = useDwarfMessaging()
    await expect(send('claude:s1', 'hi', true)).resolves.toBe(false)
  })

  it('resolves false for a second send ignored while the first is in flight', async () => {
    const pending = deferred<DwarfTextResult>()
    stubApi(() => pending.promise)
    const { send } = useDwarfMessaging()

    const first = send('claude:s1', 'one', true)
    await expect(send('claude:s1', 'two', true)).resolves.toBe(false)

    pending.release({ delivered: true, via: 'terminal' })
    await first
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

/**
 * One record per MESSAGE, beside the one per dwarf (#309).
 *
 * The panel draws the person's words the moment Enter is pressed, so it needs
 * a verdict per message rather than per dwarf: `state.byDwarfId` is the latest
 * verdict and cannot say which of three bubbles is the one that failed. Every
 * assertion below is about that second record; the per-dwarf one the shell's
 * sprite marker reads is unchanged, which the last test in this block pins.
 */
describe('useDwarfMessaging echoes', () => {
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

  /** The transcript row the session would write for a message sent at `sentAt`. */
  function turn(text: string, sentAt: number, offsetMs = 1_000): FeedMessage {
    return { role: 'user', text, timestamp: new Date(sentAt + offsetMs).toISOString() }
  }

  it('draws the message the instant it is sent, before any channel has answered', async () => {
    const pending = deferred<DwarfTextResult>()
    stubApi(() => pending.promise)
    const { send, echoesFor } = useDwarfMessaging()

    const sending = send('claude:s1', 'dig deeper', true)
    expect(echoesFor('claude:s1')).toMatchObject([
      { text: 'dig deeper', state: { phase: 'sending' } }
    ])

    pending.release({ delivered: true, via: 'terminal' })
    await sending
  })

  it("gives that one message the delivery's own verdict", async () => {
    const { send, echoesFor } = useDwarfMessaging()
    await send('claude:s1', 'dig deeper', true)
    expect(echoesFor('claude:s1')[0]?.state).toEqual({
      phase: 'delivered',
      via: 'claude-relay',
      awaitingReaction: true
    })
  })

  it('marks the message that failed, with its reason, and keeps it on screen', async () => {
    stubApi(() =>
      Promise.resolve({ delivered: false, via: 'terminal', error: 'The relay never started.' })
    )
    const { send, echoesFor, stateFor } = useDwarfMessaging()
    await send('claude:s1', 'dig deeper', true)

    expect(echoesFor('claude:s1')[0]?.state).toEqual({
      phase: 'failed',
      via: 'terminal',
      error: 'The relay never started.'
    })

    // The sprite's marker is a four-second badge and clears itself. The bubble
    // is the person's own message: it stays, marked, so it can be read and
    // sent again.
    vi.advanceTimersByTime(RESULT_VISIBLE_MS)
    expect(stateFor('claude:s1')).toBeUndefined()
    expect(echoesFor('claude:s1')[0]?.state.phase).toBe('failed')
  })

  it('promotes the message the reaction belongs to, and keeps its bubble', async () => {
    const { send, observe, echoesFor } = useDwarfMessaging()
    observe([dwarf({ status: 'working', lastMessage: 'a' })])
    await send('claude:s1', 'dig deeper', true)

    observe([dwarf({ status: 'working', lastMessage: 'on it' })])
    expect(echoesFor('claude:s1')[0]?.state).toEqual({ phase: 'reacted', via: 'claude-relay' })

    vi.advanceTimersByTime(RESULT_VISIBLE_MS)
    expect(echoesFor('claude:s1')[0]?.state.phase).toBe('reacted')
  })

  it("decays the message's own marker when the window closes unobserved", async () => {
    const { send, observe, echoesFor } = useDwarfMessaging()
    observe([dwarf({ status: 'working', lastMessage: 'a' })])
    await send('claude:s1', 'dig deeper', true)

    vi.advanceTimersByTime(REACTION_WINDOW_MS)
    expect(echoesFor('claude:s1')[0]?.state).toMatchObject({
      phase: 'delivered',
      awaitingReaction: false
    })
  })

  it('promotes only the message the watch was opened for', async () => {
    const { send, observe, echoesFor } = useDwarfMessaging()
    observe([dwarf({ status: 'working', lastMessage: 'a' })])
    await send('claude:s1', 'first', true)
    await send('claude:s1', 'second', true)

    observe([dwarf({ status: 'working', lastMessage: 'on it' })])
    const echoes = echoesFor('claude:s1')
    expect(echoes.map((echo) => [echo.text, echo.state.phase])).toEqual([
      ['first', 'delivered'],
      ['second', 'reacted']
    ])
  })

  it('mints a new message when a failed one is sent again, and leaves the failed one marked', async () => {
    stubApi(() => Promise.resolve({ delivered: false, via: 'terminal', error: 'nope' }))
    const { send, retry, echoesFor } = useDwarfMessaging()
    await send('claude:s1', 'dig deeper', true)
    const failed = echoesFor('claude:s1')[0]!

    stubApi(() => Promise.resolve({ delivered: true, via: 'claude-relay' }))
    await retry('claude:s1', failed.id)

    const echoes = echoesFor('claude:s1')
    expect(echoes).toHaveLength(2)
    expect(echoes[0]).toEqual(failed)
    expect(echoes[1]?.id).not.toBe(failed.id)
    expect(echoes[1]).toMatchObject({ text: 'dig deeper', state: { phase: 'delivered' } })
  })

  it("sends the failed message's own words, over the same channel a send uses", async () => {
    stubApi(() => Promise.resolve({ delivered: false, via: 'terminal', error: 'nope' }))
    const { send, retry, echoesFor } = useDwarfMessaging()
    await send('claude:s1', 'dig deeper', true)

    const api = vi.fn().mockResolvedValue({ delivered: true, via: 'terminal' })
    stubApi(api as never)
    await retry('claude:s1', echoesFor('claude:s1')[0]!.id)

    expect(api).toHaveBeenCalledWith({
      dwarfId: 'claude:s1',
      text: 'dig deeper',
      pressEnter: true
    })
  })

  it('refuses to send again a message it is not holding', async () => {
    const api = vi.fn().mockResolvedValue({ delivered: true, via: 'terminal' })
    stubApi(api as never)
    const { retry } = useDwarfMessaging()

    await expect(retry('claude:s1', 'never-minted')).resolves.toBe(false)
    expect(api).not.toHaveBeenCalled()
  })

  it('keeps at most the cap, dropping the oldest, so a long conversation stays bounded', async () => {
    const { send, echoesFor } = useDwarfMessaging()
    for (let index = 0; index < ECHO_LIMIT + 2; index++) {
      await send('claude:s1', `message ${index}`, true)
    }

    const echoes = echoesFor('claude:s1')
    expect(echoes).toHaveLength(ECHO_LIMIT)
    expect(echoes[0]?.text).toBe('message 2')
    expect(echoes.at(-1)?.text).toBe(`message ${ECHO_LIMIT + 1}`)
  })

  it("keeps each dwarf's own messages apart", async () => {
    const { send, echoesFor } = useDwarfMessaging()
    await send('claude:s1', 'to one', true)
    await send('claude:s2', 'to two', true)

    expect(echoesFor('claude:s1').map((echo) => echo.text)).toEqual(['to one'])
    expect(echoesFor('claude:s2').map((echo) => echo.text)).toEqual(['to two'])
  })

  it('drops a message once the transcript accounts for it', async () => {
    const { send, reconcile, echoesFor } = useDwarfMessaging()
    await send('claude:s1', 'dig deeper', true)
    const sentAt = echoesFor('claude:s1')[0]!.sentAt

    reconcile('claude:s1', [turn('dig deeper', sentAt)])
    expect(echoesFor('claude:s1')).toEqual([])
  })

  it('keeps a message the transcript does not account for', async () => {
    const { send, reconcile, echoesFor } = useDwarfMessaging()
    await send('claude:s1', 'dig deeper', true)
    const sentAt = echoesFor('claude:s1')[0]!.sentAt

    reconcile('claude:s1', [turn('something else', sentAt)])
    expect(echoesFor('claude:s1')).toHaveLength(1)
  })

  it('never brings a dropped message back when the transcript tail forgets it', async () => {
    // The tail is bounded, so the row that accounted for a message rolls off
    // it. The drop is a fact and a later poll does not take it back.
    const { send, reconcile, echoesFor } = useDwarfMessaging()
    await send('claude:s1', 'dig deeper', true)
    const sentAt = echoesFor('claude:s1')[0]!.sentAt

    reconcile('claude:s1', [turn('dig deeper', sentAt)])
    reconcile('claude:s1', [])
    expect(echoesFor('claude:s1')).toEqual([])
  })

  it('forgets every dwarf but the one the panel moved to', async () => {
    const { send, keepEchoesFor, echoesFor } = useDwarfMessaging()
    await send('claude:s1', 'to one', true)
    await send('claude:s2', 'to two', true)

    keepEchoesFor('claude:s2')
    expect(echoesFor('claude:s1')).toEqual([])
    expect(echoesFor('claude:s2')).toHaveLength(1)
  })

  it('forgets all of them when the panel is on nobody', async () => {
    const { send, keepEchoesFor, echoesFor } = useDwarfMessaging()
    await send('claude:s1', 'to one', true)

    keepEchoesFor(null)
    expect(echoesFor('claude:s1')).toEqual([])
  })

  it('drops the messages along with the verdict on clear', async () => {
    const { send, clear, echoesFor } = useDwarfMessaging()
    await send('claude:s1', 'dig deeper', true)

    clear('claude:s1')
    expect(echoesFor('claude:s1')).toEqual([])
  })

  it('leaves the per-dwarf verdict the sprite marker reads exactly as it was', async () => {
    // The whole point of a second record: the shell needs no change, and the
    // marker on the dwarf still shows the LATEST verdict (#162).
    const { send, stateFor } = useDwarfMessaging()
    await send('claude:s1', 'first', true)
    await send('claude:s1', 'second', true)

    expect(stateFor('claude:s1')).toEqual({
      phase: 'delivered',
      via: 'claude-relay',
      awaitingReaction: true
    })
  })
})
