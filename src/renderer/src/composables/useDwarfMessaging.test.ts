// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'
import type {
  DwarfId,
  HostFrame,
  HostFrames,
  IpcResult,
  MessageId,
  MessageView,
  SnapshotPage,
  SnapshotParams
} from '@dwarfai/contracts'
import { createFakeWindowApi } from '../../../contracts/ipc/testing/fakeWindowApi'
import { REACTION_WINDOW_MS } from '../lib/delivery/reaction'
import { ECHO_LIMIT } from '../lib/message/echo'
import { defaultDwarf } from '../testing/factories'
import type { Dwarf, DwarfAttachment, DwarfTextResult, FeedMessage } from '../types'
import { RESULT_VISIBLE_MS, feedMessageOf, useDwarfMessaging } from './useDwarfMessaging'

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

  /*
   * #439. A relay courier killed by its own timeout may already have called
   * SendMessage before the kill landed, so `unconfirmed: true` must NOT draw
   * as an ordinary failure — a ✕ with `Send again` risks handing the same
   * words to the session twice. It takes the 'delivered' phase instead,
   * carrying the flag through so the marker can draw its own honest sentence
   * (see deliveryVerdict.test.ts), and it starts the same reaction watch a
   * confirmed delivery does — awaitingReaction: true, not left unset the way
   * a genuine failure is.
   */
  it('treats an unconfirmed relay as delivered, not failed, and watches for a reaction', async () => {
    stubApi(() =>
      Promise.resolve({
        delivered: false,
        via: 'claude-relay',
        unconfirmed: true,
        error: 'The relay did not confirm in time; the message may have arrived.'
      })
    )
    const { send, stateFor } = useDwarfMessaging()

    await send('claude:s1', 'a very long message', true)
    expect(stateFor('claude:s1')).toEqual({
      phase: 'delivered',
      via: 'claude-relay',
      error: 'The relay did not confirm in time; the message may have arrived.',
      awaitingReaction: true,
      unconfirmed: true
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
   * Issue #417. The composer's `pending` is a `ref<readonly DwarfAttachment[]>`,
   * which Vue makes deeply reactive: the array and every attachment in it are
   * `Proxy` objects. `ipcRenderer.invoke` (what `window.api.sendDwarfText` is)
   * serialises its arguments with the structured clone algorithm, which throws
   * on a `Proxy` — Node's own `structuredClone` throws on exactly the same
   * input, which is what this test uses to reproduce the failure without
   * Electron. `deliver` must hand over plain wire objects, never the reactive
   * ones the composer happens to be holding.
   */
  it('hands the bridge plain attachment objects, never Vue reactive proxies (#417)', async () => {
    const api = vi.fn().mockResolvedValue({ delivered: true, via: 'terminal' })
    stubApi(api as never)
    const { send } = useDwarfMessaging()

    const reactiveAttachments = reactive<DwarfAttachment[]>([
      { path: 'C:\\work\\a.png', name: 'a.png', kind: 'image', bytes: 10 },
      { path: 'C:\\work\\b.txt', name: 'b.txt', kind: 'file', bytes: 20 }
    ])

    await send('claude:s1', 'hi', true, reactiveAttachments)

    const sent = api.mock.calls[0]?.[0] as { attachments: readonly DwarfAttachment[] }
    // Node's structuredClone throws a DataCloneError on a Proxy exactly as
    // Electron's IPC does — a payload that survives it carries no reactive
    // object at all.
    expect(() => structuredClone(sent.attachments)).not.toThrow()
    expect(sent.attachments).toEqual([
      { path: 'C:\\work\\a.png', name: 'a.png', kind: 'image', bytes: 10 },
      { path: 'C:\\work\\b.txt', name: 'b.txt', kind: 'file', bytes: 20 }
    ])
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

  /*
   * #439. An unconfirmed relay decays exactly like an ordinary delivered
   * message this store never saw reacted to — the whole point of carrying it
   * through the SAME reaction watch rather than a separate mechanism.
   */
  it('decays an unconfirmed relay the same way, keeping the flag through the decay', async () => {
    stubApi(() =>
      Promise.resolve({
        delivered: false,
        via: 'claude-relay',
        unconfirmed: true,
        error: 'The relay did not confirm in time; the message may have arrived.'
      })
    )
    const { send, observe, stateFor } = useDwarfMessaging()
    observe([dwarf({ status: 'working', lastMessage: 'a' })])
    await send('claude:s1', 'a very long message', true)

    vi.advanceTimersByTime(REACTION_WINDOW_MS)
    expect(stateFor('claude:s1')).toMatchObject({
      phase: 'delivered',
      awaitingReaction: false,
      unconfirmed: true
    })
  })

  it('still promotes an unconfirmed relay to reacted once the session is seen acting', async () => {
    stubApi(() =>
      Promise.resolve({
        delivered: false,
        via: 'claude-relay',
        unconfirmed: true,
        error: 'The relay did not confirm in time; the message may have arrived.'
      })
    )
    const { send, observe, stateFor } = useDwarfMessaging()
    observe([dwarf({ status: 'working', lastMessage: 'a' })])
    await send('claude:s1', 'a very long message', true)

    // Proof the words DID arrive, settling exactly what 'unconfirmed' could not.
    observe([dwarf({ status: 'working', lastMessage: 'on it' })])
    expect(stateFor('claude:s1')).toMatchObject({ phase: 'reacted', via: 'claude-relay' })
    expect(stateFor('claude:s1')?.unconfirmed).toBeUndefined()
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

  /*
   * AMENDED for #635 (decision log, Failed delivery; was: 'mints a new message when a failed one
   * is sent again, and leaves the failed one marked', #309). The PO ruled a retry re-sends the
   * same text IN PLACE: the same bubble walks the marks again, and no second one is added.
   */
  it('re-sends a failed message in place: the same message, no second one', async () => {
    stubApi(() => Promise.resolve({ delivered: false, via: 'terminal', error: 'nope' }))
    const { send, retry, echoesFor } = useDwarfMessaging()
    await send('claude:s1', 'dig deeper', true)
    const failed = echoesFor('claude:s1')[0]!

    stubApi(() => Promise.resolve({ delivered: true, via: 'claude-relay' }))
    await retry('claude:s1', failed.id)

    const echoes = echoesFor('claude:s1')
    expect(echoes).toHaveLength(1)
    expect(echoes[0]?.id).toBe(failed.id)
    expect(echoes[0]).toMatchObject({ text: 'dig deeper', state: { phase: 'delivered' } })
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

  /*
   * #635, decision log, Failed delivery — APPENDED. Retry walks the SAME message back along the
   * marks: … while it is in flight, then ✓ (and ✓✓ once acted on), or ✕ again. Its position,
   * its words and its files stay; only its verdict and its send time are the retry's.
   */
  describe('retrying in place (#635)', () => {
    async function failedOnce(text = 'dig deeper'): Promise<string> {
      stubApi(() => Promise.resolve({ delivered: false, via: 'terminal', error: 'nope' }))
      await useDwarfMessaging().send('claude:s1', text, true)
      return useDwarfMessaging().echoesFor('claude:s1').at(-1)!.id
    }

    it('walks the same message back to sending while the retry is in flight', async () => {
      const id = await failedOnce()
      const pending = deferred<DwarfTextResult>()
      stubApi(() => pending.promise)
      const { retry, echoesFor, stateFor } = useDwarfMessaging()

      const retrying = retry('claude:s1', id)
      expect(echoesFor('claude:s1').map((echo) => [echo.id, echo.state])).toEqual([
        [id, { phase: 'sending' }]
      ])
      // The sprite carries the same mark: the dwarf's own verdict is the retry's too.
      expect(stateFor('claude:s1')).toEqual({ phase: 'sending' })

      pending.release({ delivered: true, via: 'terminal' })
      await retrying
      expect(echoesFor('claude:s1')[0]?.state.phase).toBe('delivered')
    })

    it('marks the same message failed again when the retry fails too', async () => {
      const id = await failedOnce()
      stubApi(() => Promise.resolve({ delivered: false, via: 'terminal', error: 'still nope' }))
      const { retry, echoesFor } = useDwarfMessaging()

      await expect(retry('claude:s1', id)).resolves.toBe(false)
      expect(echoesFor('claude:s1')).toEqual([
        expect.objectContaining({
          id,
          state: { phase: 'failed', via: 'terminal', error: 'still nope' }
        })
      ])
    })

    it('promotes the same message once the session is seen acting on the retry', async () => {
      const { observe, retry, echoesFor } = useDwarfMessaging()
      observe([dwarf({ status: 'working', lastMessage: 'a' })])
      const id = await failedOnce()
      stubApi(() => Promise.resolve({ delivered: true, via: 'terminal' }))
      await retry('claude:s1', id)

      observe([dwarf({ status: 'working', lastMessage: 'on it' })])
      expect(echoesFor('claude:s1').map((echo) => [echo.id, echo.state.phase])).toEqual([
        [id, 'reacted']
      ])
    })

    it('stays where it was among the messages sent after it', async () => {
      const id = await failedOnce('first')
      stubApi(() => Promise.resolve({ delivered: true, via: 'terminal' }))
      const { send, retry, echoesFor } = useDwarfMessaging()
      await send('claude:s1', 'second', true)

      await retry('claude:s1', id)
      expect(echoesFor('claude:s1').map((echo) => [echo.text, echo.state.phase])).toEqual([
        ['first', 'delivered'],
        ['second', 'delivered']
      ])
    })

    /*
     * The transcript row the retry produces is stamped after the RETRY, and reconciling measures
     * a row against the echo's send time (lib/message/echo): a send time left at the failed
     * attempt would put that row outside the match window, and the words would show twice.
     */
    it("restamps the message with the retry's own send time", async () => {
      vi.setSystemTime(1_000)
      const id = await failedOnce()
      vi.setSystemTime(1_000 + REACTION_WINDOW_MS * 3)
      stubApi(() => Promise.resolve({ delivered: true, via: 'terminal' }))
      const { retry, reconcile, echoesFor } = useDwarfMessaging()
      await retry('claude:s1', id)

      reconcile('claude:s1', [
        {
          role: 'user',
          text: 'dig deeper',
          timestamp: new Date(1_000 + REACTION_WINDOW_MS * 3 + 500).toISOString()
        }
      ])
      expect(echoesFor('claude:s1')).toEqual([])
    })

    it('re-sends the files the message was sent with, and keeps them on it (#408)', async () => {
      const attachments: DwarfAttachment[] = [
        { path: 'C:/work/shot.png', name: 'shot.png', kind: 'image', bytes: 10 }
      ]
      stubApi(() => Promise.resolve({ delivered: false, via: 'terminal', error: 'nope' }))
      const { send, retry, echoesFor, attachmentsFor } = useDwarfMessaging()
      await send('claude:s1', 'look', true, attachments)
      const id = echoesFor('claude:s1')[0]!.id

      const api = vi.fn().mockResolvedValue({ delivered: true, via: 'terminal' })
      stubApi(api as never)
      await retry('claude:s1', id)

      expect(api).toHaveBeenCalledWith({
        dwarfId: 'claude:s1',
        text: 'look',
        pressEnter: true,
        attachments
      })
      expect(attachmentsFor('claude:s1', id)).toEqual(attachments)
    })

    it('refuses to re-send a message that did not fail, so a stale press never sends it twice', async () => {
      stubApi(() => Promise.resolve({ delivered: true, via: 'terminal' }))
      const { send, retry, echoesFor } = useDwarfMessaging()
      await send('claude:s1', 'arrived', true)
      const api = vi.fn().mockResolvedValue({ delivered: true, via: 'terminal' })
      stubApi(api as never)

      await expect(retry('claude:s1', echoesFor('claude:s1')[0]!.id)).resolves.toBe(false)
      expect(api).not.toHaveBeenCalled()
    })

    it('drops the message from the failed sends once the retry leaves ✕', async () => {
      const id = await failedOnce()
      stubApi(() => Promise.resolve({ delivered: true, via: 'terminal' }))
      const { retry, failedSends } = useDwarfMessaging()
      expect(Object.keys(failedSends())).toEqual(['claude:s1'])

      await retry('claude:s1', id)
      expect(failedSends()).toEqual({})
    })
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

  /*
   * #419. `echoAttachments` already held these files by echo id (#408); the
   * gap was that `reconcile` never read them, so a row that carried a
   * message's attachment tokens ahead of its words could never account for
   * the echo that sent them.
   */
  it('drops a message with attachments once the transcript row carries their tokens and words', async () => {
    const { send, reconcile, echoesFor, attachmentsFor } = useDwarfMessaging()
    const attachments: DwarfAttachment[] = [
      { path: 'C:\\work\\a.png', name: 'a.png', kind: 'image', bytes: 10 },
      { path: 'C:\\work\\b.txt', name: 'b.txt', kind: 'file', bytes: 20 }
    ]
    await send('claude:s1', 'dig deeper', true, attachments)
    const echoId = echoesFor('claude:s1')[0]!.id
    const sentAt = echoesFor('claude:s1')[0]!.sentAt

    reconcile('claude:s1', [
      {
        role: 'user',
        text: '[Image #6]C:\\work\\b.txtdig deeper',
        timestamp: new Date(sentAt + 1_000).toISOString()
      }
    ])

    expect(echoesFor('claude:s1')).toEqual([])
    expect(attachmentsFor('claude:s1', echoId)).toEqual([])
  })

  it('keeps a message with attachments the transcript row does not carry the tokens for', async () => {
    const { send, reconcile, echoesFor, attachmentsFor } = useDwarfMessaging()
    const attachments: DwarfAttachment[] = [
      { path: 'C:\\work\\a.png', name: 'a.png', kind: 'image', bytes: 10 }
    ]
    await send('claude:s1', 'dig deeper', true, attachments)
    const echoId = echoesFor('claude:s1')[0]!.id
    const sentAt = echoesFor('claude:s1')[0]!.sentAt

    // No attachment token at all — the plain-send shape, which must not
    // account for a message that was sent with a file.
    reconcile('claude:s1', [
      { role: 'user', text: 'dig deeper', timestamp: new Date(sentAt + 1_000).toISOString() }
    ])

    expect(echoesFor('claude:s1')).toHaveLength(1)
    expect(attachmentsFor('claude:s1', echoId)).toEqual(attachments)
  })

  /*
   * #424. A session held over the Agent SDK writes a user turn nothing like
   * the console's, and `echo.ts`'s `expectedTokensFor` picks the right shape
   * off the echo's own `state.via` — the same field `deliver` already writes
   * from the delivery result (see `useDwarfMessaging.ts`'s `next.via`). These
   * two prove that field actually reaches `reconcileEchoes` through this
   * composable's own `reconcile`, not just inside echo.ts's unit tests.
   */
  it('drops a held-delivered message once its own "Attached file:" row accounts for it', async () => {
    stubApi(() => Promise.resolve({ delivered: true, via: 'held-session' }))
    const { send, reconcile, echoesFor } = useDwarfMessaging()
    const attachments: DwarfAttachment[] = [
      { path: 'C:\\work\\notes.pdf', name: 'notes.pdf', kind: 'file', bytes: 20 }
    ]
    await send('claude:s1', 'dig deeper', true, attachments)
    const sentAt = echoesFor('claude:s1')[0]!.sentAt

    reconcile('claude:s1', [turn('Attached file: C:\\work\\notes.pdf\ndig deeper', sentAt)])

    expect(echoesFor('claude:s1')).toEqual([])
  })

  it('keeps a held-delivered message against the console-shaped row a different channel would have written', async () => {
    stubApi(() => Promise.resolve({ delivered: true, via: 'held-session' }))
    const { send, reconcile, echoesFor } = useDwarfMessaging()
    const attachments: DwarfAttachment[] = [
      { path: 'C:\\work\\notes.pdf', name: 'notes.pdf', kind: 'file', bytes: 20 }
    ]
    await send('claude:s1', 'dig deeper', true, attachments)
    const sentAt = echoesFor('claude:s1')[0]!.sentAt

    // The console's own shape (#419) — a bare path, never this channel's own
    // "Attached file:" line — must not account for a held delivery.
    reconcile('claude:s1', [turn('C:\\work\\notes.pdfdig deeper', sentAt)])

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

/**
 * A message the panel is HOLDING for a busy Codex thread (#457).
 *
 * Main answers `sendDwarfText` at once with a `holdId` and nothing else: the
 * words are in its memory, no channel has been asked anything, and the verdict
 * arrives minutes later on its own push. Everything below is about the store
 * keeping that honest — a marker that claims nothing, a composer that stays
 * usable, and one verdict landing on the one bubble it belongs to.
 */
describe('useDwarfMessaging holding a message for a busy thread', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useDwarfMessaging().clearAll()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function heldResult(holdId: string): DwarfTextResult {
    return { delivered: false, via: 'codex-exec-resume', holdId }
  }

  it('marks the message held rather than sending, delivered or failed', async () => {
    stubApi(() => Promise.resolve(heldResult('hold:1')))
    const { send, stateFor, echoesFor } = useDwarfMessaging()

    await send('codex:t1', 'run the tests', true)

    expect(stateFor('codex:t1')).toEqual({ phase: 'held', via: 'codex-exec-resume' })
    expect(echoesFor('codex:t1')[0]?.state.phase).toBe('held')
  })

  it('keeps that marker on screen instead of clearing it after four seconds', async () => {
    // Every other verdict is a moment; this one lasts as long as the turn it
    // is waiting for, and a marker that vanished would leave the person
    // believing the message had gone.
    stubApi(() => Promise.resolve(heldResult('hold:1')))
    const { send, stateFor } = useDwarfMessaging()

    await send('codex:t1', 'run the tests', true)
    vi.advanceTimersByTime(RESULT_VISIBLE_MS * 3)

    expect(stateFor('codex:t1')?.phase).toBe('held')
  })

  it('lets the person type again while the first message is still waiting', async () => {
    // The 'sending' guard refuses a second send for the same dwarf, and must
    // not reach this: several held messages are the whole of #457's FIFO.
    let minted = 0
    stubApi(() => Promise.resolve(heldResult(`hold:${++minted}`)))
    const { send, echoesFor } = useDwarfMessaging()

    await send('codex:t1', 'first', true)
    await send('codex:t1', 'second', true)

    expect(echoesFor('codex:t1').map((echo) => echo.text)).toEqual(['first', 'second'])
  })

  it('applies main’s later verdict to the bubble that was held', async () => {
    let minted = 0
    stubApi(() => Promise.resolve(heldResult(`hold:${++minted}`)))
    const { send, settle, stateFor, echoesFor } = useDwarfMessaging()

    await send('codex:t1', 'first', true)
    await send('codex:t1', 'second', true)
    settle({
      holdId: 'hold:1',
      dwarfId: 'codex:t1',
      result: { delivered: true, via: 'codex-exec-resume' }
    })

    const echoes = echoesFor('codex:t1')
    expect(echoes[0]?.state).toEqual({
      phase: 'delivered',
      via: 'codex-exec-resume',
      awaitingReaction: true
    })
    // The second is still waiting, and untouched by the first one's verdict.
    expect(echoes[1]?.state.phase).toBe('held')
    expect(stateFor('codex:t1')?.phase).toBe('delivered')
  })

  it('marks a held message that will never be sent as failed, with its reason', async () => {
    stubApi(() => Promise.resolve(heldResult('hold:1')))
    const { send, settle, stateFor } = useDwarfMessaging()

    await send('codex:t1', 'never mind', true)
    settle({
      holdId: 'hold:1',
      dwarfId: 'codex:t1',
      result: {
        delivered: false,
        via: 'codex-exec-resume',
        error: 'The session was ended before this message could be sent, so it was not sent.'
      }
    })

    expect(stateFor('codex:t1')).toEqual({
      phase: 'failed',
      via: 'codex-exec-resume',
      error: 'The session was ended before this message could be sent, so it was not sent.'
    })
  })

  it('ignores a verdict for a hold it is not holding', async () => {
    // The panel moved to another dwarf, or this window was reopened: a push
    // with nowhere to land changes nothing rather than inventing a marker.
    stubApi(() => Promise.resolve(heldResult('hold:1')))
    const { send, settle, stateFor } = useDwarfMessaging()

    await send('codex:t1', 'run the tests', true)
    settle({
      holdId: 'hold:9',
      dwarfId: 'codex:t1',
      result: { delivered: true, via: 'codex-exec-resume' }
    })

    expect(stateFor('codex:t1')?.phase).toBe('held')
  })
})

/*
 * The app's own record of a message that never reached its session (#635, PANEL-QUESTIONS 16),
 * which the shell's history draws: the words and when they were sent, for every echo whose verdict
 * is failed, per dwarf, oldest first. Nothing else is in it.
 */
describe('useDwarfMessaging failed sends', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useDwarfMessaging().clearAll()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('lists each failed message with its words and send time, and no other', async () => {
    const { send, failedSends } = useDwarfMessaging()
    stubApi(async () => ({ delivered: true, via: 'terminal' }))
    await send('claude:s1', 'arrived', true)
    stubApi(async () => ({ delivered: false, via: 'none', error: 'gone' }))
    vi.setSystemTime(5_000)
    await send('claude:s1', 'never arrived', true)
    expect(failedSends()).toEqual({ 'claude:s1': [{ text: 'never arrived', sentAt: 5_000 }] })
  })
})

/* --- The "Answers:" record (#635, MESSAGE-QUESTIONS 8) — one block, appended ---- */

/*
 * The record of an answer given on the ask's own channel (decision log, Answers bubble is a
 * record). It is drawn with the person's other bubbles, so it lives among the echoes, but it is
 * never sent: its marks are the answer's own verdict, … until the answer is handed over, ✓ once it
 * is, ✓✓ only once the dwarf is seen acting after it, ✕ if the channel refused it, and when in
 * doubt it stays at ✓.
 */
describe('useDwarfMessaging: the "Answers:" record', () => {
  const RECORD = 'Answers:\n\n- Which store: **Redis**'
  const sendDwarfText = vi.fn(() => Promise.resolve({ delivered: true, via: 'terminal' } as const))

  beforeEach(() => {
    vi.useFakeTimers()
    useDwarfMessaging().clearAll()
    sendDwarfText.mockClear()
    stubApi(sendDwarfText)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function dwarf(overrides: Partial<Dwarf> = {}): Dwarf {
    return defaultDwarf({ id: 'claude:s1', ...overrides })
  }

  it('draws the record at once, in sending, and sends nothing', () => {
    vi.setSystemTime(7_000)
    const { recordAnswer, echoesFor } = useDwarfMessaging()
    const id = recordAnswer('claude:s1', RECORD)
    expect(echoesFor('claude:s1')).toEqual([
      { id, text: RECORD, sentAt: 7_000, state: { phase: 'sending' }, answers: true }
    ])
    expect(sendDwarfText).not.toHaveBeenCalled()
  })

  // AMENDED for #635 (MESSAGE-QUESTIONS 20; was: 'never writes the dwarf’s own verdict, which is
  // the messages’', expecting none): the dwarf's marker carries the record's marks, as a message's.
  it('writes the dwarf’s own verdict too, which the sprite marker reads', () => {
    const { recordAnswer, settleAnswer, stateFor } = useDwarfMessaging()
    const id = recordAnswer('claude:s1', RECORD)
    expect(stateFor('claude:s1')).toEqual({ phase: 'sending' })
    settleAnswer('claude:s1', id, { answered: true })
    expect(stateFor('claude:s1')).toEqual({ phase: 'delivered', awaitingReaction: true })
  })

  it('walks to ✓ once the answer is handed over on its channel, still watching', () => {
    const { recordAnswer, settleAnswer, echoesFor } = useDwarfMessaging()
    const id = recordAnswer('claude:s1', RECORD)
    settleAnswer('claude:s1', id, { answered: true })
    expect(echoesFor('claude:s1')[0]?.state).toEqual({ phase: 'delivered', awaitingReaction: true })
  })

  it('walks to ✓✓ only once the dwarf is seen acting after the answer', () => {
    const { recordAnswer, settleAnswer, observe, echoesFor } = useDwarfMessaging()
    observe([dwarf({ status: 'waiting', lastMessage: 'Which store?' })])
    const id = recordAnswer('claude:s1', RECORD)
    settleAnswer('claude:s1', id, { answered: true })

    observe([dwarf({ status: 'waiting', lastMessage: 'Which store?' })])
    expect(echoesFor('claude:s1')[0]?.state.phase).toBe('delivered')

    observe([dwarf({ status: 'working', lastMessage: 'Which store?' })])
    expect(echoesFor('claude:s1')[0]?.state).toEqual({ phase: 'reacted' })
  })

  it('stays at ✓ when no action is seen before the window closes', () => {
    const { recordAnswer, settleAnswer, observe, echoesFor } = useDwarfMessaging()
    observe([dwarf({ status: 'waiting', lastMessage: 'Which store?' })])
    const id = recordAnswer('claude:s1', RECORD)
    settleAnswer('claude:s1', id, { answered: true })

    vi.advanceTimersByTime(REACTION_WINDOW_MS)
    observe([dwarf({ status: 'working', lastMessage: 'Something else' })])
    expect(echoesFor('claude:s1')[0]?.state).toEqual({
      phase: 'delivered',
      awaitingReaction: false
    })
  })

  it('reads ✕ with the channel’s reason when the answer was refused', () => {
    const { recordAnswer, settleAnswer, echoesFor } = useDwarfMessaging()
    const id = recordAnswer('claude:s1', RECORD)
    settleAnswer('claude:s1', id, { answered: false, error: 'The ask had closed.' })
    expect(echoesFor('claude:s1')[0]?.state).toEqual({
      phase: 'failed',
      error: 'The ask had closed.'
    })
  })

  it('keeps a message’s own watch apart from the answer’s', async () => {
    const { send, recordAnswer, settleAnswer, observe, echoesFor } = useDwarfMessaging()
    observe([dwarf({ status: 'waiting', lastMessage: 'a' })])
    await send('claude:s1', 'also this', true)
    const id = recordAnswer('claude:s1', RECORD)
    settleAnswer('claude:s1', id, { answered: true })

    observe([dwarf({ status: 'working', lastMessage: 'b' })])
    expect(echoesFor('claude:s1').map((echo) => echo.state.phase)).toEqual(['reacted', 'reacted'])
  })

  it('is not a failed send for the history, since it was never a message', () => {
    const { recordAnswer, settleAnswer, failedSends } = useDwarfMessaging()
    const id = recordAnswer('claude:s1', RECORD)
    settleAnswer('claude:s1', id, { answered: false, error: 'refused' })
    expect(failedSends()).toEqual({})
  })

  it('refuses a retry: the card is how the ask is answered again', async () => {
    const { recordAnswer, settleAnswer, retry } = useDwarfMessaging()
    const id = recordAnswer('claude:s1', RECORD)
    settleAnswer('claude:s1', id, { answered: false, error: 'refused' })
    expect(await retry('claude:s1', id)).toBe(false)
    expect(sendDwarfText).not.toHaveBeenCalled()
  })
})
/* --- end of the "Answers:" record block ------------------------------------- */

/* --- MESSAGE-QUESTIONS 19, 20 and 22 on the "Answers:" record — one block, appended ---------- */

describe('useDwarfMessaging: the "Answers:" record, rulings 19, 20 and 22', () => {
  const RECORD = 'Answers:\n\n- Which store: **Redis**'
  const AGAIN = 'Answers:\n\n- Which store: **Memory**'
  const sendDwarfText = vi.fn(() => Promise.resolve({ delivered: true, via: 'terminal' } as const))

  beforeEach(() => {
    vi.useFakeTimers()
    useDwarfMessaging().clearAll()
    sendDwarfText.mockClear()
    stubApi(sendDwarfText)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function dwarf(overrides: Partial<Dwarf> = {}): Dwarf {
    return defaultDwarf({ id: 'claude:s1', ...overrides })
  }

  /* MESSAGE-QUESTIONS 19: the next Submit after a refusal replaces the refused record in place. */
  it('replaces the refused record of the same ask in place, with the new words and time', () => {
    const { recordAnswer, settleAnswer, echoesFor } = useDwarfMessaging()
    vi.setSystemTime(1_000)
    const first = recordAnswer('claude:s1', RECORD, 'toolu_01')
    settleAnswer('claude:s1', first, { answered: false, error: 'nope' })

    vi.setSystemTime(9_000)
    const again = recordAnswer('claude:s1', AGAIN, 'toolu_01')
    expect(again).toBe(first)
    expect(echoesFor('claude:s1')).toEqual([
      {
        id: first,
        text: AGAIN,
        sentAt: 9_000,
        state: { phase: 'sending' },
        answers: true,
        ask: 'toolu_01'
      }
    ])
  })

  it('keeps it in its place among the other bubbles', async () => {
    const { send, recordAnswer, settleAnswer, echoesFor } = useDwarfMessaging()
    const first = recordAnswer('claude:s1', RECORD, 'toolu_01')
    settleAnswer('claude:s1', first, { answered: false, error: 'nope' })
    await send('claude:s1', 'meanwhile', true)
    recordAnswer('claude:s1', AGAIN, 'toolu_01')
    expect(echoesFor('claude:s1').map((echo) => echo.text)).toEqual([AGAIN, 'meanwhile'])
  })

  it('adds a new record for another ask, and never replaces one that was handed over', () => {
    const { recordAnswer, settleAnswer, echoesFor } = useDwarfMessaging()
    const refused = recordAnswer('claude:s1', RECORD, 'toolu_01')
    settleAnswer('claude:s1', refused, { answered: false, error: 'nope' })
    const other = recordAnswer('claude:s1', AGAIN, 'toolu_02')
    settleAnswer('claude:s1', other, { answered: true })
    const third = recordAnswer('claude:s1', RECORD, 'toolu_02')
    expect(new Set([refused, other, third]).size).toBe(3)
    expect(echoesFor('claude:s1')).toHaveLength(3)
  })

  /* MESSAGE-QUESTIONS 20: the dwarf's marker carries the record's marks. */
  it('walks the dwarf’s marker to ✓✓ only once the dwarf is seen acting', () => {
    const { recordAnswer, settleAnswer, observe, stateFor } = useDwarfMessaging()
    observe([dwarf({ status: 'waiting', lastMessage: 'Which store?' })])
    const id = recordAnswer('claude:s1', RECORD, 'toolu_01')
    settleAnswer('claude:s1', id, { answered: true })
    observe([dwarf({ status: 'waiting', lastMessage: 'Which store?' })])
    expect(stateFor('claude:s1')?.phase).toBe('delivered')
    observe([dwarf({ status: 'working', lastMessage: 'Which store?' })])
    expect(stateFor('claude:s1')).toEqual({ phase: 'reacted' })
  })

  it('puts ✕ with the reason on the dwarf’s marker when the answer was refused', () => {
    const { recordAnswer, settleAnswer, stateFor } = useDwarfMessaging()
    const id = recordAnswer('claude:s1', RECORD, 'toolu_01')
    settleAnswer('claude:s1', id, { answered: false, error: 'That question is no longer open.' })
    expect(stateFor('claude:s1')).toEqual({
      phase: 'failed',
      error: 'That question is no longer open.'
    })
  })

  it('stays at ✓ on the marker when the window closes unseen', () => {
    const { recordAnswer, settleAnswer, stateFor } = useDwarfMessaging()
    const id = recordAnswer('claude:s1', RECORD, 'toolu_01')
    settleAnswer('claude:s1', id, { answered: true })
    vi.advanceTimersByTime(REACTION_WINDOW_MS)
    expect(stateFor('claude:s1')).toEqual({ phase: 'delivered', awaitingReaction: false })
  })

  it('leaves the marker to a message sent after the answer, whatever the answer does next', async () => {
    const { send, recordAnswer, settleAnswer, observe, stateFor, echoesFor } = useDwarfMessaging()
    observe([dwarf({ status: 'waiting', lastMessage: 'a' })])
    const id = recordAnswer('claude:s1', RECORD, 'toolu_01')
    settleAnswer('claude:s1', id, { answered: true })
    const pending = deferred<DwarfTextResult>()
    stubApi(() => pending.promise)
    const sending = send('claude:s1', 'and this', true)

    observe([dwarf({ status: 'working', lastMessage: 'a' })])
    expect(echoesFor('claude:s1')[0]?.state).toEqual({ phase: 'reacted' })
    expect(stateFor('claude:s1')).toEqual({ phase: 'sending' })
    pending.release({ delivered: true, via: 'terminal' })
    await sending
  })

  /* MESSAGE-QUESTIONS 22: each dwarf's records are kept for the app run, across switching chats. */
  it('keeps every dwarf’s records when the chat moves to another dwarf', async () => {
    const { send, recordAnswer, keepEchoesFor, echoesFor } = useDwarfMessaging()
    recordAnswer('claude:s1', RECORD, 'toolu_01')
    await send('claude:s1', 'a message on its way', true)
    keepEchoesFor('claude:s2')
    expect(echoesFor('claude:s1').map((echo) => echo.text)).toEqual([RECORD])
    keepEchoesFor('claude:s1')
    expect(echoesFor('claude:s1').map((echo) => echo.text)).toEqual([RECORD])
  })

  it('still walks a kept record’s marks while another chat is open', () => {
    const { recordAnswer, settleAnswer, keepEchoesFor, observe, echoesFor } = useDwarfMessaging()
    observe([dwarf({ status: 'waiting', lastMessage: 'a' })])
    const id = recordAnswer('claude:s1', RECORD, 'toolu_01')
    keepEchoesFor('claude:s2')
    settleAnswer('claude:s1', id, { answered: true })
    observe([dwarf({ status: 'working', lastMessage: 'a' })])
    expect(echoesFor('claude:s1')[0]?.state).toEqual({ phase: 'reacted' })
  })
})
/* --- end of the rulings 19, 20 and 22 block ------------------------------------------------- */

/*
 * The composer's own lines (its hint, its in-flight Send) are about the person's MESSAGES: an
 * answer's verdict rides on the dwarf's marker (MESSAGE-QUESTIONS 20) and on its record, whose ✕
 * title carries a refusal's reason (MESSAGE-QUESTIONS 21), never in the composer's hint.
 */
describe('useDwarfMessaging: the composer reads messages only', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useDwarfMessaging().clearAll()
    stubApi(() => Promise.resolve({ delivered: true, via: 'terminal' }))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('says nothing of an answer’s verdict, and still says a message’s', async () => {
    const { send, recordAnswer, settleAnswer, messageStateFor } = useDwarfMessaging()
    const id = recordAnswer('claude:s1', 'Answers:\n\n- Which store: **Redis**', 'toolu_01')
    expect(messageStateFor('claude:s1')).toBeUndefined()
    settleAnswer('claude:s1', id, { answered: false, error: 'That question is no longer open.' })
    expect(messageStateFor('claude:s1')).toBeUndefined()

    await send('claude:s1', 'then this', true)
    expect(messageStateFor('claude:s1')?.phase).toBe('delivered')
  })

  it('lets a message go out while an answer is still on its way', async () => {
    const { send, recordAnswer } = useDwarfMessaging()
    recordAnswer('claude:s1', 'Answers:\n\n- Which store: **Redis**', 'toolu_01')
    expect(await send('claude:s1', 'meanwhile', true)).toBe(true)
  })
})

/*
 * THE CHAT FROM THE HOST (ISSUE-106; ADR-033 item 3; 14 §4.3, §6.4 row `useDwarfMessaging`).
 *
 * Every dwarf's chat becomes a read model of the snapshot `tails` section and the `conversation.appended` frames,
 * relayed by A-N01 `getHostSnapshot` and A-N02 `onHostEvent`: subscribe first, read the snapshot, then apply only the
 * frames newer than it. The Host merges a provider's echo of a DwarfAI message by `source_key` (INV-60), so the chat
 * keeps one row per `MessageId` and never reconciles echoes of its own. Retired A-14 `getDwarfFeed`, A-16
 * `setWatchedDwarf` and A-17 `refreshDwarfTelemetry` are never called on this path. Tested against the generated fake
 * `window.api` with scripted frames (ADR-033 item 7).
 */
describe('useDwarfMessaging chat from the Host read model', () => {
  type Api = Window['api']
  type SnapshotAnswer = IpcResult<SnapshotPage>

  const EPOCH = 'epoch-1'
  const BORIN = '01920000-0000-7000-8000-00000000d001' as DwarfId
  const DAIN = '01920000-0000-7000-8000-00000000d002' as DwarfId
  const id = (n: number) =>
    `01920000-0000-7000-8000-00000000e${String(n).padStart(3, '0')}` as MessageId
  /** 2026-10-06T09:00:00.000Z, in epoch ms. */
  const NINE = 1_791_277_200_000

  function view(n: number, overrides: Partial<MessageView> = {}): MessageView {
    return {
      id: id(n),
      dwarfId: BORIN,
      role: n % 2 === 1 ? 'person' : 'dwarf',
      text: `line ${n}`,
      attachments: [],
      providerTime: null,
      createdAt: NINE + n * 60_000,
      ...overrides
    }
  }

  function tails(
    ...entries: Array<{ dwarfId: DwarfId; messages: MessageView[] }>
  ): SnapshotPage['chunks'] {
    return [{ section: 'tails', data: entries.map((entry) => ({ ...entry, reachedStart: false })) }]
  }

  function page(seq: number, chunks: SnapshotPage['chunks']): SnapshotAnswer {
    return { ok: true, value: { snapshotId: `snap-${seq}`, seq, epoch: EPOCH, chunks } }
  }

  function frame<F extends keyof HostFrames>(seq: number, name: F, data: HostFrames[F]): HostFrame {
    return { type: 'evt', seq, epoch: EPOCH, name, data } as HostFrame
  }

  interface Host {
    push(frames: HostFrame[]): void
    requests: SnapshotParams[]
    api: Api
  }

  /** The fake `window.api`: A-N01 answers each scripted answer in turn (the last repeats); A-N02 is scripted. */
  function installHost(answers: Array<SnapshotAnswer | (() => SnapshotAnswer)>): Host {
    let listener: ((frames: HostFrame[]) => void) | null = null
    const requests: SnapshotParams[] = []
    let next = 0
    const api = createFakeWindowApi({
      getHostSnapshot: vi.fn((request: SnapshotParams) => {
        requests.push(request)
        const answer = answers[Math.min(next, answers.length - 1)]!
        next += 1
        return Promise.resolve(typeof answer === 'function' ? answer() : answer)
      }) as unknown as Api['getHostSnapshot'],
      onHostEvent: vi.fn((follow: (frames: HostFrame[]) => void) => {
        listener = follow
        return () => {
          listener = null
        }
      }) as unknown as Api['onHostEvent'],
      getDwarfFeed: vi.fn() as unknown as Api['getDwarfFeed'],
      setWatchedDwarf: vi.fn() as unknown as Api['setWatchedDwarf'],
      refreshDwarfTelemetry: vi.fn() as unknown as Api['refreshDwarfTelemetry']
    })
    Object.defineProperty(window, 'api', { configurable: true, value: api })
    return {
      push(frames) {
        if (listener === null) throw new Error('nothing follows onHostEvent')
        listener(frames)
      },
      requests,
      api
    }
  }

  async function settle(): Promise<void> {
    for (let i = 0; i < 10; i += 1) await Promise.resolve()
  }

  const chatOf = (dwarfId: DwarfId) => useDwarfMessaging().hostFeedOf(dwarfId)
  const textsOf = (dwarfId: DwarfId) => chatOf(dwarfId)?.messages.map((message) => message.text)

  beforeEach(() => {
    useDwarfMessaging().stopChat()
  })

  afterEach(() => {
    useDwarfMessaging().stopChat()
  })

  it("[ADR-033] a dwarf's chat is built from its tails chunk and then from conversation.appended frames with a higher seq", async () => {
    const host = installHost([page(5, tails({ dwarfId: BORIN, messages: [view(1), view(2)] }))])
    expect(await useDwarfMessaging().startChat()).toBe(true)
    host.push([frame(6, 'conversation.appended', { dwarfId: BORIN, messages: [view(3)] })])
    expect(chatOf(BORIN)).toEqual({
      readable: true,
      messages: [
        { role: 'user', text: 'line 1', timestamp: '2026-10-06T09:01:00.000Z' },
        { role: 'assistant', text: 'line 2', timestamp: '2026-10-06T09:02:00.000Z' },
        { role: 'user', text: 'line 3', timestamp: '2026-10-06T09:03:00.000Z' }
      ]
    })
    expect(useDwarfMessaging().hostOldestMessageId(BORIN)).toBe(id(1))
    expect(host.api.getDwarfFeed).not.toHaveBeenCalled()
    expect(host.api.setWatchedDwarf).not.toHaveBeenCalled()
    expect(host.api.refreshDwarfTelemetry).not.toHaveBeenCalled()
  })

  it('[ADR-033] a frame with seq at or below the snapshot seq is ignored, and resync-required re-reads the snapshot', async () => {
    let host: Host | null = null
    host = installHost([
      () => {
        // Arrives while the snapshot is read: buffered, then dropped, as the snapshot already reflects seq 5.
        host!.push([frame(5, 'conversation.appended', { dwarfId: BORIN, messages: [view(9)] })])
        return page(5, tails({ dwarfId: BORIN, messages: [view(1)] }))
      },
      page(8, tails({ dwarfId: BORIN, messages: [view(1), view(2), view(3)] }))
    ])
    await useDwarfMessaging().startChat()
    await settle()
    host.push([frame(4, 'conversation.appended', { dwarfId: BORIN, messages: [view(7)] })])
    expect(textsOf(BORIN)).toEqual(['line 1'])

    host.push([frame(6, 'resync-required', { reason: 'ring-overrun' })])
    await settle()
    expect(host.requests).toHaveLength(2)
    expect(textsOf(BORIN)).toEqual(['line 1', 'line 2', 'line 3'])
  })

  it('[INV-60] a message the Host sent twice with the same id is shown once, with no client echo merging', async () => {
    const host = installHost([page(5, tails({ dwarfId: BORIN, messages: [view(1)] }))])
    await useDwarfMessaging().startChat()
    host.push([
      frame(6, 'conversation.appended', { dwarfId: BORIN, messages: [view(2)] }),
      frame(7, 'conversation.appended', {
        dwarfId: BORIN,
        messages: [view(2, { text: 'line 2, as the Host merged it' })]
      })
    ])
    expect(textsOf(BORIN)).toEqual(['line 1', 'line 2, as the Host merged it'])
    // The panel's own echoes are not this chat's rows: the Host's chat holds only what the Host sent.
    expect(useDwarfMessaging().echoesFor(BORIN)).toEqual([])
  })

  it('[ADR-033] a dwarf missing from a re-snapshot is removed without a walk-out', async () => {
    const host = installHost([
      page(
        5,
        tails(
          { dwarfId: BORIN, messages: [view(1)] },
          { dwarfId: DAIN, messages: [view(2, { dwarfId: DAIN })] }
        )
      ),
      page(9, tails({ dwarfId: BORIN, messages: [view(1)] }))
    ])
    await useDwarfMessaging().startChat()
    expect(textsOf(DAIN)).toEqual(['line 2'])
    host.push([frame(6, 'resync-required', { reason: 'seq-not-in-ring' })])
    await settle()
    expect(chatOf(DAIN)).toBeUndefined()
    expect(textsOf(BORIN)).toEqual(['line 1'])
  })

  it('[ADR-033] until the route switch a refused snapshot leaves the chat unfed', async () => {
    installHost([
      { ok: false, error: { code: 'METHOD_NOT_FOUND', message: 'unrouted', retryable: false } }
    ])
    expect(await useDwarfMessaging().startChat()).toBe(false)
    expect(chatOf(BORIN)).toBeUndefined()
    expect(useDwarfMessaging().hostOldestMessageId(BORIN)).toBeNull()
  })

  it("[ADR-033] a Host row maps to today's FeedMessage by its role and its provider time when it has one", () => {
    expect(
      [
        view(1, { role: 'person' }),
        view(2, { role: 'dwarf', providerTime: NINE }),
        view(3, { role: 'answers-record' }),
        view(4, { role: 'system-line' })
      ].map(feedMessageOf)
    ).toEqual([
      { role: 'user', text: 'line 1', timestamp: '2026-10-06T09:01:00.000Z' },
      { role: 'assistant', text: 'line 2', timestamp: '2026-10-06T09:00:00.000Z' },
      { role: 'user', text: 'line 3', timestamp: '2026-10-06T09:03:00.000Z' },
      { role: 'assistant', text: 'line 4', timestamp: '2026-10-06T09:04:00.000Z' }
    ])
  })
})
