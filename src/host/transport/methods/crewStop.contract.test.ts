// layer: L6
// L6 (17 §1.6): B-M21 `crew.stop` (14 §2.3, §3.4 `StopDwarfParams`, `StopDwarfResult`, frozen;
// ADR-019; AMENDMENT-2, OQ-54): its strict() schemas, and the method over the real seam-B
// transport — frame codec, hello-first authentication, roles, the Host dispatcher main composes
// with its requestId de-duplication — behind in-process duplexes, over crew's `stop` on its
// in-memory doubles and a SessionTerminator double (its own behaviour is the L2 flow,
// wiring/flows/stopDwarf.test.ts). And the toast rule of ADR-014 item 6 (14 §2.4 B-F28): a failed
// "Stop dwarf…" is one `toast {dwarf-stop-failed}` frame, a failed Remove mine or stop-all end none
// per dwarf (wiring/routes/launching.ts `routeStops`).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest'
import type { z } from 'zod'
import {
  CHANNELS,
  ROW_IDS,
  type ChannelSpec,
  HOST_FRAME_SCHEMAS,
  PROTOCOL_VERSION,
  resFrameSchema,
  HOST_METHOD_SCHEMAS,
  type DwarfId,
  type HostFrameData,
  type HostFrameName,
  type HostMethods,
  type StopDwarfParams,
  type StopDwarfResult
} from '@dwarfai/contracts'
import type { DwarfId as HostDwarfId, EventId, HostEpoch, MineId } from '../../kernel/domain/values'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingEventBus } from '../../kernel/fakes/RecordingEventBus'
import { RecordingStopAll } from '../../kernel/fakes/RecordingStopAll'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import type { TransactionRunner } from '../../kernel/ports/transactionRunner'
import {
  CrewStop,
  type CrewEndEvent,
  type EndOutcome,
  type EndReason,
  type SessionTerminator
} from '../../modules/crew'
import { CREW_EPOCH, inMemoryCrew } from '../../modules/crew/testing/inMemoryCrew'
import { emptyDrainGate } from '../../wiring/emptyDrainGate'
import { createHostDispatcher } from '../../wiring/hostDispatcher'
import { routeStops } from '../../wiring/routes/launching'
import { HelloThrottle } from '../auth/throttle'
import { UI_TOKEN_FILE, UiToken } from '../auth/uiToken'
import { collectCapabilities } from '../capabilities'
import { acceptConnection } from '../connection'
import { ConnectionRegistry, type AttachedConnection } from '../connectionRegistry'
import { createUpgradeDrain } from '../lifecycle/drain'
import { HostStateHolder } from '../lifecycle/hostState'
import { SectionRegistry } from '../snapshot/sectionRegistry'
import { FrameClient } from '../testing/frameClient'
import { inProcessDuplex } from '../testing/inProcessDuplex'
import { registerCrewStop } from './crewStop'
import { createUpgradeTargetRule } from './hostUpgradeRequest'

const DWARF = '01890a5d-ac96-774b-bcce-b302099a8171'
const REQUEST = '01890a5d-ac96-774b-bcce-b302099a8172'

describe('crew.stop params and result (14 §3.4, B-M21)', () => {
  it('[ADR-019] crew.stop params are strict and the A-N29 row maps to crew.stop', () => {
    expect(Object.keys(HOST_METHOD_SCHEMAS)).toContain('crew.stop')
    expectTypeOf<StopDwarfParams>().toEqualTypeOf<{ dwarfId: DwarfId; requestId: string }>()
    expectTypeOf<StopDwarfResult>().toEqualTypeOf<
      // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- 14 §3.4 spells the empty value as {}
      { ok: true; value: {} } | { ok: false; error: 'already-stopping' | 'could-not-end' }
    >()
    expectTypeOf<HostMethods['crew.stop']['params']>().toEqualTypeOf<StopDwarfParams>()
    expectTypeOf<HostMethods['crew.stop']['result']>().toEqualTypeOf<StopDwarfResult>()
    expectTypeOf<
      z.infer<(typeof HOST_METHOD_SCHEMAS)['crew.stop']['params']>
    >().toEqualTypeOf<StopDwarfParams>()
    expectTypeOf<
      z.infer<(typeof HOST_METHOD_SCHEMAS)['crew.stop']['result']>
    >().toEqualTypeOf<StopDwarfResult>()

    const stop = HOST_METHOD_SCHEMAS['crew.stop']
    expect(stop.params.safeParse({ dwarfId: DWARF, requestId: REQUEST }).success).toBe(true)
    for (const invalid of [
      { dwarfId: DWARF },
      { requestId: REQUEST },
      { dwarfId: 'dwarf-1', requestId: REQUEST },
      { dwarfId: DWARF, requestId: 'req-1' },
      // No member interrupts only the turn (OQ-49, OQ-54): there is no mode to pass.
      { dwarfId: DWARF, requestId: REQUEST, mode: 'turn' }
    ]) {
      expect(stop.params.safeParse(invalid).success, JSON.stringify(invalid)).toBe(false)
    }
    expect(stop.result.safeParse({ ok: true, value: {} }).success).toBe(true)
    expect(stop.result.safeParse({ ok: false, error: 'already-stopping' }).success).toBe(true)
    expect(stop.result.safeParse({ ok: false, error: 'could-not-end' }).success).toBe(true)
    // AMENDMENT-2 (OQ-54): an open turn is not a refusal.
    expect(stop.result.safeParse({ ok: false, error: 'turn-open' }).success).toBe(false)
    expect(stop.result.safeParse({ ok: true, value: { ended: true } }).success).toBe(false)

    // A-N29 `stopDwarf` / `dwarf:stop` relays B-M21 unchanged (14 §1.2, §2.2): the same params, its
    // result inside IpcResult.
    const row = (CHANNELS as Record<string, ChannelSpec<z.ZodTypeAny, z.ZodTypeAny> | undefined>)[
      'dwarf:stop'
    ]
    expect(row).toMatchObject({
      name: 'dwarf:stop',
      kind: 'invoke',
      placement: 'host',
      status: 'new'
    })
    expect(row?.request).toBe(stop.params)
    expectTypeOf<
      z.infer<(typeof CHANNELS)['dwarf:stop']['request']>
    >().toEqualTypeOf<StopDwarfParams>()
    for (const result of [
      { ok: true, value: {} },
      { ok: false, error: 'already-stopping' },
      { ok: false, error: 'could-not-end' }
    ]) {
      expect(row?.response.safeParse({ ok: true, value: result }).success).toBe(true)
    }
    expect(row?.response.safeParse({ ok: true, value: {} }).success).toBe(false)
    expect(row?.response.safeParse({ ok: false, error: 'could-not-end' }).success).toBe(false)
    expect(
      row?.response.safeParse({
        ok: false,
        error: { code: 'INVALID_PARAMS', message: 'no', retryable: false }
      }).success
    ).toBe(true)
    expect(ROW_IDS['dwarf:stop']).toBe('A-N29')
  })
})

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

const EPOCH = 'epoch-0171'
const MINE = '00000000-0000-7000-8000-0000000000f1' as MineId
const RID = (n: number): string =>
  `01890a5d-ac96-774b-bcce-${(0x1710 + n).toString(16).padStart(12, '0')}`

function validateFrame(name: string, data: unknown): void {
  const schemas: Readonly<Record<string, z.ZodTypeAny | undefined>> = HOST_FRAME_SCHEMAS
  const schema = schemas[name]
  if (schema === undefined) throw new Error(`no contract schema for ${name}`)
  schema.parse(data)
}

/** A terminator whose ends stay pending until the test settles them. */
class GatedTerminator implements SessionTerminator {
  readonly calls: Array<{ dwarfId: HostDwarfId; why: EndReason }> = []
  private readonly gates: Array<(outcome: EndOutcome) => void> = []

  end(dwarfId: HostDwarfId, why: EndReason): Promise<EndOutcome> {
    this.calls.push({ dwarfId, why })
    return new Promise((resolve) => this.gates.push(resolve))
  }

  endAll(): Promise<Map<HostDwarfId, EndOutcome>> {
    throw new Error('crew.stop ends one dwarf, never through endAll')
  }

  settle(outcome: EndOutcome): void {
    for (const gate of this.gates.splice(0)) gate(outcome)
  }
}

/** Crew's `stop` over the in-memory crew, on a bus that refuses a publish inside its transaction. */
function crewWithStop(terminator: SessionTerminator) {
  const crew = inMemoryCrew()
  let open = false
  const transactions: TransactionRunner = {
    inTransaction<T>(work: () => T): T {
      const outer = open
      open = true
      try {
        return crew.transactionRunner.inTransaction(work)
      } finally {
        open = outer
      }
    }
  }
  const bus = new RecordingEventBus<CrewEndEvent>({
    transactionScope: { isInTransaction: () => open }
  })
  const stop = new CrewStop({
    repository: crew.repository,
    transactions,
    bus,
    clock: crew.clock,
    ids: new SequenceIdGenerator(),
    hostEpoch: CREW_EPOCH,
    terminator,
    departures: crew.commands
  })
  return { crew, bus, stop }
}

/** One Host transport serving B-M21 over crew's `stop`; one present dwarf, mid-turn. */
async function host(terminator: SessionTerminator) {
  const root = mkdtempSync(join(tmpdir(), 'dwarfai-171-stop-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const token = new UiToken()
  await token.issue(join(root, 'run'))
  const secret = readFileSync(join(root, 'run', UI_TOKEN_FILE), 'utf8')
  const clock = new FakeClock(1_000)
  const scheduler = new FakeScheduler(clock)
  const log = new RecordingDiagnosticsLog()
  const connections = new ConnectionRegistry({ validateFrame })
  const state = new HostStateHolder(connections)
  state.report({ state: 'ready', jobStatus: 'none' })
  const sections = new SectionRegistry()
  const ids = new SequenceIdGenerator()
  const lifecycle = { closeCleanly: () => Promise.resolve() }
  const dispatcher = createHostDispatcher({
    log,
    clock,
    scheduler,
    state: () => state.current().state,
    stopAll: new RecordingStopAll(),
    lifecycle,
    connections,
    epoch: EPOCH,
    ids,
    sections,
    snapshotMeta: {
      hostVersion: () => '0.17.1',
      state: () => state.current().state,
      resetEpoch: () => 0,
      snapshotTail: () => 20,
      minesEverKnown: () => false
    },
    drain: createUpgradeDrain({ gate: emptyDrainGate, state, scheduler, lifecycle, log }),
    upgradeTarget: createUpgradeTargetRule({
      platform: 'linux',
      root: null,
      realpath: () => {
        throw new Error('no copy root in this case')
      }
    })
  })

  const { crew, stop } = crewWithStop(terminator)
  const dwarfId = crew.commands.arrive({
    mineId: MINE,
    identity: { providerId: 'codex', providerSessionId: 'thread-171' },
    rank: 'foreman',
    status: 'working'
  })
  /** Every call that reached crew, in order. */
  const reached: string[] = []
  registerCrewStop(dispatcher, {
    stops: {
      stop: (id, requestId) => {
        reached.push('stop')
        return stop.stop(id, requestId)
      }
    },
    queries: crew.queries
  })

  const throttle = new HelloThrottle(clock)
  /** Connects with `role` and returns the client once hello.ok arrived. */
  const attach = async (role: 'ui' | 'notifier'): Promise<FrameClient> => {
    const pair = inProcessDuplex()
    acceptConnection(pair.host, {
      token,
      ids,
      identity: { hostVersion: '0.17.1', buildId: 'abc1234', protocolVersion: PROTOCOL_VERSION },
      epoch: EPOCH,
      state: () => state.current(),
      capabilities: () =>
        collectCapabilities({
          methods: dispatcher.methods(),
          frames: [],
          sections: sections.names()
        }),
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
      client: { appVersion: '0.17.1', buildId: 'abc1234', pid: 4242 }
    })
    await client.settle()
    expect(client.frames[0]).toMatchObject({ type: 'hello.ok' })
    return client
  }

  return { attach, crew, dwarfId, reached }
}

let nextId = 0

type Res = z.infer<typeof resFrameSchema>

/** Sends one request; resolves with its `res` frame once it arrives. */
async function call(client: FrameClient, method: string, params: unknown): Promise<Res> {
  nextId += 1
  const id = `req-${nextId}`
  client.send({ type: 'req', id, method, params })
  await client.until(() => client.frames.some((frame) => isRes(frame, id)))
  return resFrameSchema.parse(client.frames.find((frame) => isRes(frame, id)))
}

function isRes(frame: unknown, id: string): boolean {
  return (
    (frame as { type?: string; id?: string }).type === 'res' && (frame as { id?: string }).id === id
  )
}

function resultOf(res: Res): unknown {
  if (!res.ok) throw new Error(`refused: ${res.error.code}`)
  return res.result
}

function codeOf(res: Res): string | undefined {
  return res.ok ? undefined : res.error.code
}

/** Lets the queued promise callbacks run. */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 50; turn++) await new Promise((resolve) => setImmediate(resolve))
}

describe('crew.stop over seam B (B-M21)', () => {
  it('[US-MSG-008.AC03, US-MSG-016.AC01, ADR-003] crew.stop of a working dwarf answers {} once its session ended; a repeated requestId gets the first answer with no second stop', async () => {
    const terminator = new GatedTerminator()
    const { attach, crew, dwarfId, reached } = await host(terminator)
    const ui = await attach('ui')
    expect(crew.queries.get(dwarfId)?.status).toBe('working')

    const answer = call(ui, 'crew.stop', { dwarfId, requestId: RID(1) })
    await flush()
    // Effects before response (14 §1.7): no answer while the end has not settled.
    expect(ui.frames.some((frame) => (frame as { type?: string }).type === 'res')).toBe(false)
    expect(terminator.calls).toStrictEqual([{ dwarfId, why: 'stop-dwarf' }])
    terminator.settle({ kind: 'ended' })
    const first = await answer

    expect(resultOf(first)).toStrictEqual({ ok: true, value: {} })
    expect(HOST_METHOD_SCHEMAS['crew.stop'].result.safeParse(resultOf(first)).success).toBe(true)
    expect(crew.queries.get(dwarfId)?.departed).toBe(true)

    const again = await call(ui, 'crew.stop', { dwarfId, requestId: RID(1) })
    expect(resultOf(again)).toStrictEqual(resultOf(first))
    expect(reached).toStrictEqual(['stop'])
    expect(terminator.calls).toHaveLength(1)
  })

  it('[US-MSG-016.AC02] a second crew.stop while the first is in flight answers already-stopping and ends nothing more', async () => {
    const terminator = new GatedTerminator()
    const { attach, crew, dwarfId } = await host(terminator)
    const ui = await attach('ui')

    const first = call(ui, 'crew.stop', { dwarfId, requestId: RID(1) })
    await flush()
    expect(crew.queries.get(dwarfId)?.stopUnavailableReason).toBe('already-stopping')
    const second = await call(ui, 'crew.stop', { dwarfId, requestId: RID(2) })
    expect(resultOf(second)).toStrictEqual({ ok: false, error: 'already-stopping' })
    expect(terminator.calls).toHaveLength(1)

    terminator.settle({ kind: 'failed', reason: 'still-alive' })
    expect(resultOf(await first)).toStrictEqual({ ok: false, error: 'could-not-end' })
    expect(crew.queries.get(dwarfId)?.departed).toBe(false)
    expect(crew.queries.get(dwarfId)?.stopUnavailableReason).toBeNull()
  })

  it('[ADR-019] a notifier gets FORBIDDEN; an unknown dwarf, a missing requestId or another key gets INVALID_PARAMS before crew runs', async () => {
    const { attach, dwarfId, reached } = await host(new GatedTerminator())
    const ui = await attach('ui')
    const notifier = await attach('notifier')

    expect(codeOf(await call(notifier, 'crew.stop', { dwarfId, requestId: RID(1) }))).toBe(
      'FORBIDDEN'
    )
    for (const params of [
      { dwarfId: RID(99), requestId: RID(2) },
      { dwarfId },
      { dwarfId, requestId: RID(3), mode: 'turn' }
    ]) {
      expect(codeOf(await call(ui, 'crew.stop', params)), JSON.stringify(params)).toBe(
        'INVALID_PARAMS'
      )
    }
    expect(reached).toStrictEqual([])
  })
})

describe('the stop failure toast (14 §2.4 B-F28; ADR-014 item 6)', () => {
  it('[ADR-014] a stop failure produces exactly one toast frame and a remove-mine or stop-all failure none per dwarf', () => {
    const bus = new RecordingEventBus<CrewEndEvent>()
    const connections = new ConnectionRegistry({ validateFrame })
    const sent: Array<{ name: HostFrameName; data: unknown }> = []
    const ui: AttachedConnection = {
      role: 'ui',
      clientId: 'c-ui',
      send<F extends HostFrameName>(name: F, data: HostFrameData[F]): void {
        sent.push({ name, data })
      },
      end: async () => undefined
    }
    connections.attach(ui)
    const marked: HostDwarfId[] = []
    routeStops({
      events: bus,
      launching: { commands: { markStoppedByPerson: (dwarfId) => marked.push(dwarfId) } },
      frames: connections
    })
    const failed = (dwarfId: string, requestId: string, why: EndReason): CrewEndEvent => ({
      type: 'DwarfStopFailed',
      v: 1,
      id: `event-${dwarfId}-${why}` as EventId,
      at: 1_000,
      hostEpoch: 'epoch-0171' as HostEpoch,
      payload: { dwarfId: dwarfId as HostDwarfId, requestId, why, reason: 'could-not-end' }
    })

    bus.publish(failed(RID(10), RID(1), 'stop-dwarf'))
    bus.publish(failed(RID(11), RID(2), 'remove-mine'))
    bus.publish(failed(RID(12), RID(2), 'remove-mine'))
    bus.publish(failed(RID(13), RID(3), 'stop-all'))
    bus.publish(failed(RID(14), RID(4), 'delegation-done'))

    expect(sent).toStrictEqual([
      {
        name: 'toast',
        data: { kind: 'dwarf-stop-failed', requestId: RID(1), dwarfId: RID(10) }
      }
    ])
    expect(marked).toStrictEqual([])
  })
})
