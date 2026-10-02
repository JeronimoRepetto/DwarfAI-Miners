// layer: L6
// L6 (17 §1.6): B-M07 `presence` (14 §2.3, §3.4 `PresenceParams`; ADR-003 item 12; ADR-018 item 2;
// ADR-024 D7) over the real seam-B transport — frame codec, hello-first authentication, roles, the
// dispatcher and the connection registry — behind in-process duplexes, feeding the real attention
// module (16 §4.11 `presenceChanged`) through its index only (R15), over inline doubles of its
// two driven ports: system notifications on, and an in-memory ledger.
//
// TC-111-02, TC-111-03.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { HOST_FRAME_SCHEMAS, PROTOCOL_VERSION, resFrameSchema } from '@dwarfai/contracts'
import type { DwarfId, MineId } from '../../kernel/domain/values'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingEventBus } from '../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import type { TransactionRunner } from '../../kernel/ports/transactionRunner'
import {
  createAttention,
  type AttentionEvent,
  type AttentionFact,
  type AttentionInputs,
  type AttentionLedger,
  type Presence
} from '../../modules/attention'
import { HelloThrottle } from '../auth/throttle'
import { UI_TOKEN_FILE, UiToken } from '../auth/uiToken'
import { collectCapabilities } from '../capabilities'
import { acceptConnection } from '../connection'
import { ConnectionRegistry } from '../connectionRegistry'
import { Dispatcher } from '../dispatcher'
import { HostStateHolder } from '../lifecycle/hostState'
import { FrameClient } from '../testing/frameClient'
import { inProcessDuplex } from '../testing/inProcessDuplex'
import { registerPresence } from './presence'

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

const EPOCH = 'epoch-0111'
const T0 = 1_790_000_000_000
const MINE = '01890a5d-ac96-774b-bcce-b302099a8111' as MineId
const OTHER_MINE = '01890a5d-ac96-774b-bcce-b302099a8112' as MineId
const DWARF = '01890a5d-ac96-774b-bcce-b302099ad111' as DwarfId

const ASK: AttentionFact = {
  key: `${DWARF}:question:ask-1`,
  kind: 'question',
  dwarfId: DWARF,
  mineId: MINE,
  at: T0,
  reannounce: true
}

function validateFrame(name: string, data: unknown): void {
  const schemas: Readonly<Record<string, z.ZodTypeAny | undefined>> = HOST_FRAME_SCHEMAS
  const schema = schemas[name]
  if (schema === undefined) throw new Error(`no contract schema for ${name}`)
  schema.parse(data)
}

/** An in-memory `AttentionLedger`: the claimed keys only, no carry-over (16 §4.11). */
class MemoryLedger implements AttentionLedger {
  private readonly claimed = new Set<string>()
  private readonly withdrawn = new Set<string>()
  emitted(): ReadonlySet<string> {
    return this.claimed
  }
  markEmitted(key: string): void {
    this.claimed.add(key)
  }
  markSuppressed(key: string): void {
    this.claimed.add(key)
  }
  carryOver(): ReadonlyMap<string, string> {
    return new Map()
  }
  consumeCarryOver(): void {}
  withdraw(keys: readonly string[]): readonly string[] {
    const fresh = keys.filter((key) => this.claimed.has(key) && !this.withdrawn.has(key))
    for (const key of fresh) this.withdrawn.add(key)
    return fresh
  }
  sweepWithdrawn(): number {
    return 0
  }
  dropCarryOver(): void {}
}

/** Every `presenceChanged` the transport handed on, in order. */
class RecordingAttentionInputs implements Pick<AttentionInputs, 'presenceChanged'> {
  readonly calls: Array<[string, Presence | 'detached']> = []
  presenceChanged(uiClient: string, presence: Presence | 'detached'): void {
    this.calls.push([uiClient, presence])
  }
}

/** One Host transport serving B-M07 to `attention`. */
async function host(attention: Pick<AttentionInputs, 'presenceChanged'>) {
  const root = mkdtempSync(join(tmpdir(), 'dwarfai-111-presence-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const token = new UiToken()
  await token.issue(join(root, 'run'))
  const secret = readFileSync(join(root, 'run', UI_TOKEN_FILE), 'utf8')
  const clock = new FakeClock(T0)
  const scheduler = new FakeScheduler(clock)
  const log = new RecordingDiagnosticsLog()
  const connections = new ConnectionRegistry({ validateFrame })
  const state = new HostStateHolder(connections)
  state.report({ state: 'ready', jobStatus: 'none' })
  const ids = new SequenceIdGenerator()
  const dispatcher = new Dispatcher({ log, clock, scheduler, state: () => state.current().state })
  cleanups.push(registerPresence(dispatcher, { attention, connections }))

  const throttle = new HelloThrottle(clock)
  /** Connects with `role` and returns the client once hello.ok arrived. */
  const attach = async (role: 'ui' | 'notifier'): Promise<FrameClient> => {
    const pair = inProcessDuplex()
    acceptConnection(pair.host, {
      token,
      ids,
      identity: { hostVersion: '0.21.0', buildId: 'abc1234', protocolVersion: PROTOCOL_VERSION },
      epoch: EPOCH,
      state: () => state.current(),
      capabilities: () =>
        collectCapabilities({ methods: dispatcher.methods(), frames: [], sections: [] }),
      scheduler,
      clock,
      log,
      dispatcher,
      connections,
      throttle
    })
    const client = new FrameClient(pair.client)
    cleanups.push(() => void pair.client.destroy())
    client.send({
      type: 'hello',
      endpointGeneration: 1,
      protocolVersion: PROTOCOL_VERSION,
      role,
      token: secret,
      client: { appVersion: '0.21.0', buildId: 'abc1234', pid: 4242 }
    })
    await client.settle()
    expect(client.frames[0]).toMatchObject({ type: 'hello.ok' })
    return client
  }

  return { attach, dispatcher, connections }
}

/** The real attention module, its published events recorded. */
function attentionModule() {
  let open = false
  const transactions: TransactionRunner = {
    inTransaction<T>(work: () => T): T {
      open = true
      try {
        return work()
      } finally {
        open = false
      }
    }
  }
  const bus = new RecordingEventBus<AttentionEvent>({
    transactionScope: { isInTransaction: () => open }
  })
  const attention = createAttention({
    settings: { systemNotificationsOn: () => true },
    ledger: new MemoryLedger(),
    transactions,
    bus,
    clock: new FakeClock(T0),
    ids: new SequenceIdGenerator(),
    hostEpoch: EPOCH,
    titles: (kind, name) => `${kind}:${name}`
  })
  return { inputs: attention.inputs, bus }
}

let nextId = 0

type Res = z.infer<typeof resFrameSchema>

/** Sends one request and returns its `res` frame. */
async function call(client: FrameClient, method: string, params: unknown): Promise<Res> {
  nextId += 1
  const id = `req-${nextId}`
  client.send({ type: 'req', id, method, params })
  await client.until(() => client.frames.some((frame) => isRes(frame, id)))
  return resFrameSchema.parse(client.frames.find((frame) => isRes(frame, id)))
}

function isRes(frame: unknown, id: string): boolean {
  return (frame as { type?: string }).type === 'res' && (frame as { id?: string }).id === id
}

function codeOf(res: Res): string | undefined {
  return res.ok ? undefined : res.error.code
}

const report = (seq: number, onScreenMineIds: string[], anyWindowVisible = true) => ({
  onScreenMineIds,
  anyWindowVisible,
  seq
})

describe('presence over seam B (B-M07)', () => {
  it('[ADR-003] presence is accepted on a ui connection and refused with FORBIDDEN on notifier and viewer', async () => {
    const attention = new RecordingAttentionInputs()
    const { attach, dispatcher, connections } = await host(attention)
    const ui = await attach('ui')
    const notifier = await attach('notifier')
    const uiClient = connections.connections().find((c) => c.role === 'ui')?.clientId

    expect(await call(ui, 'presence', report(1, [MINE]))).toMatchObject({ ok: true, result: {} })
    expect(codeOf(await call(notifier, 'presence', report(1, [MINE])))).toBe('FORBIDDEN')
    const viewer = await dispatcher.dispatch(
      { id: 'v1', method: 'presence', params: report(1, [MINE]) },
      { role: 'viewer', clientId: 'viewer-1' }
    )
    expect(codeOf(viewer)).toBe('FORBIDDEN')
    // TC-111-03: an invalid payload never reaches the attention policy.
    for (const params of [
      { ...report(2, [MINE]), anyUiAttached: true },
      report(2, ['mine-1']),
      { onScreenMineIds: [MINE], seq: 2 }
    ]) {
      expect(codeOf(await call(ui, 'presence', params))).toBe('INVALID_PARAMS')
    }

    // The ui connection closes: its report leaves the union (16 §4.11 `'detached'`).
    ui.stream.destroy()
    await notifier.settle()
    await notifier.until(() => connections.connections().length === 1)

    expect(attention.calls).toStrictEqual([
      [
        uiClient,
        {
          anyUiAttached: true,
          anyWindowVisible: true,
          onScreenMineIds: new Set([MINE]),
          seq: 1
        }
      ],
      [uiClient, 'detached']
    ])
  })

  it('[ADR-018] a presence with an older seq than the last one of that client is ignored', async () => {
    const { inputs, bus } = attentionModule()
    const { attach } = await host(inputs)
    const ui = await attach('ui')

    await call(ui, 'presence', report(5, [MINE]))
    inputs.onFact(ASK, { displayName: 'Gimli', mineName: 'Moria' }) // on screen: gated
    // An older report that would take the mine off screen changes nothing.
    await call(ui, 'presence', report(4, [OTHER_MINE]))
    expect(bus.ofType('AttentionNotified')).toStrictEqual([])

    await call(ui, 'presence', report(6, [OTHER_MINE]))
    expect(bus.ofType('AttentionNotified').map((e) => e.payload.key)).toStrictEqual([ASK.key])
  })
})
