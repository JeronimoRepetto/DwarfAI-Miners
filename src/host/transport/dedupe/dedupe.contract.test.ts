// layer: L6
// requestId de-duplication at the seam-B dispatcher (ADR-003 item 6, frozen; 14 §1.6, §1.7, §6.5
// "Idempotency"; 13 FM-034; 18 T-17 / C-14; 19 §9.2 `channel.dedupe`). A test mutating method
// counts its effects and publishes one test frame onto an ordered wire record, where every `res`
// lands when the dispatcher answers, as the connection writes it.
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { Dispatcher, type ResponseFrame } from '../dispatcher'
import { METHOD_ROLES } from '../roles'
import { DEDUPE_TTL_MS } from './requestTable'
import { DURABLE_KEY_METHODS, MUTATING_METHODS } from './mutatingMethods'

const R = '01890a5d-ac96-774b-bcce-b302099a8057'
const METHOD = 'test.mutate'
const UI = { role: 'ui' as const, clientId: 'conn-1' }
const UI_AFTER_RECONNECT = { role: 'ui' as const, clientId: 'conn-2' }
const SECRET_TEXT = 'params-text-never-logged'
const SECRET_RESULT = 'result-never-logged'

const paramsSchema = z.object({ text: z.string(), requestId: z.string().optional() }).strict()

interface Rig {
  dispatcher: Dispatcher
  wire: unknown[]
  log: RecordingDiagnosticsLog
  clock: FakeClock
  effects: () => number
  seenRequestIds: string[]
  /** Holds the handler in flight until `release()`. */
  hold: () => void
  release: () => void
  send: (id: string, params: unknown, context?: typeof UI) => Promise<ResponseFrame>
}

function rig(
  base?: Pick<Rig, 'clock' | 'log'> & { scheduler: FakeScheduler },
  fail = false
): Rig & { scheduler: FakeScheduler } {
  const clock = base?.clock ?? new FakeClock()
  const scheduler = base?.scheduler ?? new FakeScheduler(clock)
  const log = base?.log ?? new RecordingDiagnosticsLog()
  const dispatcher = new Dispatcher({ log, clock, scheduler, state: () => 'ready' })
  const wire: unknown[] = []
  const seenRequestIds: string[] = []
  let effects = 0
  let gate: Promise<void> = Promise.resolve()
  let open = (): void => {}
  dispatcher.registerMutating(METHOD, paramsSchema, ['ui'], async (_params, context) => {
    effects += 1
    seenRequestIds.push(context.requestId)
    await gate
    wire.push({ type: 'evt', name: 'test.effect', payload: { effect: effects } })
    if (fail) throw new Error('handler failed')
    return { effect: effects, note: SECRET_RESULT }
  })
  return {
    dispatcher,
    wire,
    log,
    clock,
    scheduler,
    seenRequestIds,
    effects: () => effects,
    hold: () => {
      gate = new Promise((resolve) => (open = resolve))
    },
    release: () => open(),
    send: (id, params, context = UI) =>
      dispatcher.dispatch({ id, method: METHOD, params }, context).then((res) => {
        wire.push(res)
        return res
      })
  }
}

describe('requestId de-duplication (ADR-003 item 6, 14 §1.6)', () => {
  it('[ADR-003, FM-034] the same requestId twice while the first is in flight produces one effect and two identical results', async () => {
    const t = rig()
    t.hold()
    const first = t.send('1', { text: SECRET_TEXT, requestId: R })
    const repeat = t.send('7', { text: SECRET_TEXT, requestId: R }, UI_AFTER_RECONNECT)
    t.release()
    const [a, b] = await Promise.all([first, repeat])

    expect(t.effects()).toBe(1)
    expect(a).toEqual({
      type: 'res',
      id: '1',
      ok: true,
      result: { effect: 1, note: SECRET_RESULT }
    })
    expect(b).toEqual({
      type: 'res',
      id: '7',
      ok: true,
      result: { effect: 1, note: SECRET_RESULT }
    })
  })

  it('[ADR-003, FM-034] the same requestId after settlement returns the first result verbatim with no second effect', async () => {
    const t = rig()
    const first = await t.send('1', { text: SECRET_TEXT, requestId: R })
    t.clock.advance(DEDUPE_TTL_MS - 1)
    const repeat = await t.send('2', { text: 'a different text', requestId: R })

    expect(t.effects()).toBe(1)
    expect(repeat).toEqual({ ...first, id: '2' })

    t.clock.advance(1) // 10 min after settlement the table has forgotten R
    const later = await t.send('3', { text: SECRET_TEXT, requestId: R })
    expect(t.effects()).toBe(2)
    expect(later).toMatchObject({ ok: true, result: { effect: 2 } })
  })

  it('[ADR-003] a joined repeat receives its res after the frames of the first call', async () => {
    const t = rig()
    t.hold()
    const first = t.send('1', { text: SECRET_TEXT, requestId: R })
    const repeat = t.send('2', { text: SECRET_TEXT, requestId: R })
    t.release()
    await Promise.all([first, repeat])

    expect(t.wire.map((frame) => (frame as { type: string; id?: string }).id ?? 'evt')).toEqual([
      'evt',
      '1',
      '2'
    ])
  })

  it('[ADR-003] a handler failure settles as INTERNAL and its repeat gets that same answer with no second effect', async () => {
    const t = rig(undefined, true)
    const first = await t.send('1', { text: SECRET_TEXT, requestId: R })
    const repeat = await t.send('2', { text: SECRET_TEXT, requestId: R })

    expect(first).toMatchObject({ ok: false, error: { code: 'INTERNAL' } })
    expect(repeat).toEqual({ ...first, id: '2' })
    expect(t.effects()).toBe(1)
  })

  it('[ADR-003] a mutating method without a valid UUIDv7 requestId gets INVALID_PARAMS', async () => {
    const t = rig()
    const invalid = [
      { text: SECRET_TEXT },
      { text: SECRET_TEXT, requestId: '9b2f6c1e-3d4a-4f5b-8c6d-7e8f9a0b1c2d' }, // a v4 UUID
      { text: SECRET_TEXT, requestId: 'send-1' }
    ]
    for (const [index, params] of invalid.entries()) {
      const res = await t.send(String(index), params)
      expect(res, JSON.stringify(params)).toMatchObject({
        ok: false,
        error: { code: 'INVALID_PARAMS', retryable: false }
      })
    }
    expect(t.effects()).toBe(0)
  })

  it('[ADR-003] the handler receives the requestId, so a module can key it durably', async () => {
    const t = rig()
    await t.send('1', { text: SECRET_TEXT, requestId: R })
    expect(t.seenRequestIds).toEqual([R])
    // 14 §1.6: only these three re-send across a Host restart; their modules key R durably.
    expect([...DURABLE_KEY_METHODS].sort()).toEqual([
      'asking.answerPermission',
      'asking.answerQuestion',
      'conversation.send'
    ])
    for (const method of DURABLE_KEY_METHODS) expect(MUTATING_METHODS.has(method)).toBe(true)
  })

  it('[ADR-003] a new Host process starts with an empty table', async () => {
    const before = rig()
    await before.send('1', { text: SECRET_TEXT, requestId: R })
    await before.send('2', { text: SECRET_TEXT, requestId: R })
    expect(before.effects()).toBe(1)

    // The transport rebuilt over the same fakes, as a new Host process would build it.
    const after = rig({ clock: before.clock, log: before.log, scheduler: before.scheduler })
    await after.send('1', { text: SECRET_TEXT, requestId: R })
    expect(after.effects()).toBe(1)
    expect(after.wire).toContainEqual(
      expect.objectContaining({ ok: true, result: { effect: 1, note: SECRET_RESULT } })
    )
  })

  it('[ADR-003] a dedupe is logged as channel.dedupe with the requestId only, never params or result', async () => {
    const t = rig()
    await t.send('1', { text: SECRET_TEXT, requestId: R })
    await t.send('2', { text: SECRET_TEXT, requestId: R })

    expect(t.log.byEvent('channel.dedupe')).toEqual([
      { level: 'debug', event: 'channel.dedupe', subsystem: 'transport', requestId: R }
    ])
    const logged = JSON.stringify(t.log.entries)
    expect(logged).not.toContain(SECRET_TEXT)
    expect(logged).not.toContain(SECRET_RESULT)
  })

  it('[ADR-003] the methods whose 14 §3.4 params carry requestId register only as mutating, and no other 14 §2.3 method may', () => {
    expect(MUTATING_METHODS.size).toBe(23)
    const dispatcher = new Dispatcher({
      log: new RecordingDiagnosticsLog(),
      clock: new FakeClock(),
      state: () => 'ready'
    })
    for (const method of Object.keys(METHOD_ROLES)) {
      const plain = (): void => dispatcher.register(method, z.object({}), ['ui'], () => ({}))
      const mutating = (): void =>
        dispatcher.registerMutating(method, z.object({}), ['ui'], () => ({}))
      if (MUTATING_METHODS.has(method)) {
        expect(plain, method).toThrow(/mutating/)
        mutating()
      } else {
        expect(mutating, method).toThrow(/not mutating/)
        plain()
      }
    }
    for (const method of MUTATING_METHODS) expect(METHOD_ROLES).toHaveProperty([method])
  })
})
