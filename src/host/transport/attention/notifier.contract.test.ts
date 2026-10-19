// layer: L6
// L6 (17 §1.6): the tray notifier connection over the real seam-B transport — frame codec,
// hello-first authentication, roles, the dispatcher and the connection registry — behind
// in-process duplexes, with a `ui` and a `notifier` client. The real attention module (through its
// index only, R15) decides; `TransportLevel3Sink` frames `attention.notify` (B-F22, sensitive) and
// `attention.withdraw` (B-F23) to the `notifier` connection only; B-M08 `attention.clicked` is a
// counter. ADR-003 item 12; ADR-018 items 5, 6, 9; 14 §2.3 "Notifier scope", §2.4, §3.5, §6.5
// "Roles"; 16 §4.11; 07 S12.C03, S17.01, S17.06; 19 §9.6.
//
// TC-112-01, TC-112-02, TC-112-03, TC-112-04.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  HOST_FRAME_SCHEMAS,
  PROTOCOL_VERSION,
  SENSITIVE_FRAMES,
  resFrameSchema
} from '@dwarfai/contracts'
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
  type AttentionLedger
} from '../../modules/attention'
import { HelloThrottle } from '../auth/throttle'
import { UI_TOKEN_FILE, UiToken } from '../auth/uiToken'
import { collectCapabilities } from '../capabilities'
import { acceptConnection } from '../connection'
import { ConnectionRegistry } from '../connectionRegistry'
import { MUTATING_METHODS } from '../dedupe/mutatingMethods'
import { Dispatcher } from '../dispatcher'
import { HostStateHolder } from '../lifecycle/hostState'
import { registerAttentionClicked } from '../methods/attentionClicked'
import { METHOD_ROLES } from '../roles'
import { FrameClient } from '../testing/frameClient'
import { inProcessDuplex } from '../testing/inProcessDuplex'
import { registerNotifierAttached, TransportLevel3Sink } from './TransportLevel3Sink'

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

const EPOCH = 'epoch-0112'
const T0 = 1_790_000_000_000
const MINE = '01890a5d-ac96-774b-bcce-b302099a8112' as MineId
const DWARF = '01890a5d-ac96-774b-bcce-b302099ad112' as DwarfId
/** Synthetic canaries (privacy-guard): a custom name and a mine name no log line may carry. */
const CANARY_NAME = 'Canary-Dwarf-7f3e'
const CANARY_MINE = 'Canary-Mine-b41c'
const NAMES = { displayName: CANARY_NAME, mineName: CANARY_MINE }

function ask(askId: string): AttentionFact {
  return {
    key: `${DWARF}:question:${askId}`,
    kind: 'question',
    dwarfId: DWARF,
    mineId: MINE,
    at: T0,
    reannounce: true
  }
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

/** One Host transport with the attention module behind the notifier connection. */
async function host() {
  const root = mkdtempSync(join(tmpdir(), 'dwarfai-112-notifier-'))
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
  const sink = new TransportLevel3Sink(connections)
  const attention = createAttention({
    settings: { systemNotificationsOn: () => true },
    ledger: new MemoryLedger(),
    transactions,
    bus: new RecordingEventBus<AttentionEvent>({
      transactionScope: { isInTransaction: () => open }
    }),
    sink,
    clock,
    ids: new SequenceIdGenerator(),
    hostEpoch: EPOCH,
    titles: (kind, displayName) => `${displayName} ${kind}`
  })
  registerAttentionClicked(dispatcher, { attention: attention.inputs })
  cleanups.push(registerNotifierAttached(connections, attention))

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

  return { attach, attention, sink, dispatcher, connections, log }
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

/** The `evt` frames a client received, as `[name, data]`. */
function events(client: FrameClient): Array<[string, unknown]> {
  return client.frames
    .filter((frame) => (frame as { type?: string }).type === 'evt')
    .map((frame) => {
      const evt = frame as { name: string; data: unknown }
      return [evt.name, evt.data]
    })
}

function notification(askId: string) {
  return {
    key: ask(askId).key,
    kind: 'question',
    title: `${CANARY_NAME} question`,
    body: CANARY_MINE,
    mineId: MINE,
    dwarfId: DWARF,
    sensitive: true
  }
}

describe('notifier connection (ADR-003 item 12)', () => {
  it('[ADR-018] a level-3 notification given to the Level3Sink is sent as attention.notify on the notifier connection and never on a ui connection', async () => {
    const h = await host()
    const ui = await h.attach('ui')
    const notifier = await h.attach('notifier')

    h.attention.inputs.onFact(ask('ask-1'), NAMES)
    await notifier.settle()
    await ui.settle()

    expect(events(notifier)).toStrictEqual([['attention.notify', notification('ask-1')]])
    expect(events(ui)).toStrictEqual([])
  })

  it('[ADR-018] a withdrawal is sent as attention.withdraw with the keys', async () => {
    const h = await host()
    const ui = await h.attach('ui')
    const notifier = await h.attach('notifier')
    h.attention.inputs.onFact(ask('ask-1'), NAMES)

    h.attention.inputs.onFactEnded(ask('ask-1').key)
    await notifier.settle()
    await ui.settle()

    expect(events(notifier)).toStrictEqual([
      ['attention.notify', notification('ask-1')],
      ['attention.withdraw', { keys: [ask('ask-1').key] }]
    ])
    expect(events(ui)).toStrictEqual([])
  })

  it('[ADR-018, S17.01] a notification decided with no notifier attached is sent when the notifier says hello, unless its fact ended meanwhile', async () => {
    const h = await host()
    const ui = await h.attach('ui')
    expect(h.sink.notify(notification('probe') as never)).toBe('no-ui')

    h.attention.inputs.onFact(ask('ask-1'), NAMES)
    h.attention.inputs.onFact(ask('ask-2'), NAMES)
    h.attention.inputs.onFactEnded(ask('ask-1').key)

    const notifier = await h.attach('notifier')
    await notifier.settle()
    await ui.settle()

    expect(events(notifier)).toStrictEqual([['attention.notify', notification('ask-2')]])
    expect(events(ui)).toStrictEqual([])
  })

  it('[ADR-003] attention.clicked from a notifier is accepted as a counter; from ui or viewer it gets FORBIDDEN', async () => {
    const h = await host()
    const ui = await h.attach('ui')
    const notifier = await h.attach('notifier')
    h.attention.inputs.onFact(ask('ask-1'), NAMES)
    await notifier.settle()

    expect(await call(notifier, 'attention.clicked', { key: ask('ask-1').key })).toMatchObject({
      ok: true,
      result: {}
    })
    expect(codeOf(await call(ui, 'attention.clicked', { key: ask('ask-1').key }))).toBe('FORBIDDEN')
    const viewer = await h.dispatcher.dispatch(
      { id: 'v1', method: 'attention.clicked', params: { key: ask('ask-1').key } },
      { role: 'viewer', clientId: 'viewer-1' }
    )
    expect(codeOf(viewer)).toBe('FORBIDDEN')
    expect(codeOf(await call(notifier, 'attention.clicked', { key: 1 }))).toBe('INVALID_PARAMS')

    // A counter only: no frame, no window raise, nothing else changed (ADR-018 item 6).
    expect(h.attention.clicks()).toBe(1)
    await notifier.settle()
    await ui.settle()
    expect(events(notifier).map(([name]) => name)).toStrictEqual(['attention.notify'])
    expect(events(ui)).toStrictEqual([])
  })

  it('[ADR-003] the notifier cannot call any mutating method (FORBIDDEN)', async () => {
    const h = await host()
    const handled: string[] = []
    for (const method of MUTATING_METHODS) {
      h.dispatcher.registerMutating(
        method,
        z.object({}).passthrough(),
        METHOD_ROLES[method] ?? [],
        () => {
          handled.push(method)
          return {}
        }
      )
    }
    const notifier = await h.attach('notifier')

    for (const method of MUTATING_METHODS) {
      const res = await call(notifier, method, {
        requestId: '01890a5d-ac96-774b-bcce-b302099a0112'
      })
      expect(codeOf(res), method).toBe('FORBIDDEN')
    }
    expect(handled).toStrictEqual([])
  })

  it('[NFR-SEC-12] a canary custom name in an OsNotification never reaches a log line', async () => {
    expect(SENSITIVE_FRAMES).toContain('attention.notify')
    const h = await host()
    await h.attach('ui')
    h.attention.inputs.onFact(ask('ask-1'), NAMES) // no notifier yet: kept
    const notifier = await h.attach('notifier') // sent on hello
    await notifier.settle()
    await call(notifier, 'attention.clicked', { key: ask('ask-1').key })
    h.attention.inputs.onFactEnded(ask('ask-1').key)
    await notifier.settle()

    expect(JSON.stringify(events(notifier))).toContain(CANARY_NAME) // the frame carried it
    const written = JSON.stringify([h.log.entries, h.log.refused])
    expect(written).not.toContain(CANARY_NAME)
    expect(written).not.toContain(CANARY_MINE)
    expect(h.log.entries.length).toBeGreaterThan(0)
  })
})
