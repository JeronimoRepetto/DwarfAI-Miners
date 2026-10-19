// layer: L6
// L6 (17 §1.6): B-M18 `mines.remove` (14 §2.3, §3.4 `RemoveMineResult`, §1.6, §1.7) with the frames
// it causes — B-F10 `dwarf.departed`, B-F07 `mine.removed`, B-F28 `toast {mine-removal-failed}` (14
// §2.4, §3.5, §3.6) — over the real seam-B transport: frame codec, hello-first authentication,
// roles, the Host dispatcher with its requestId de-duplication and the connection registry, behind
// in-process duplexes. The mines and crew modules run over one copy of the template database (schema
// v1) with a real temporary folder as the mine; the sessions are ended by a SessionTerminator double
// (ADR-014 item 1), and the board frames are projected by frames/board.ts. Every frame is validated
// against its contract schema (14 §1.4).
//
// TC-080-01, TC-080-02, TC-080-03.
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  evtFrameSchema,
  HOST_FRAME_SCHEMAS,
  HOST_METHOD_SCHEMAS,
  PROTOCOL_VERSION,
  resFrameSchema,
  type FolderPath
} from '@dwarfai/contracts'
import type { EndOutcome } from '../../kernel/domain/processIdentity'
import type { DwarfId, MineId } from '../../kernel/domain/values'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingEventBus } from '../../kernel/fakes/RecordingEventBus'
import { RecordingStopAll } from '../../kernel/fakes/RecordingStopAll'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import {
  createCrew,
  type CrewEndEvent,
  type CrewEvent,
  type EndReason,
  type SessionTerminator
} from '../../modules/crew'
import { createMines, type MinesEvent } from '../../modules/mines'
import type { ObservationEvent } from '../../modules/observation'
import { NodeFs } from '../../platform/fs/NodeFs'
import { SqliteLifecycleFactLog } from '../../platform/sqlite/SqliteLifecycleFactLog'
import { SqliteTransactionRunner } from '../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../platform/sqlite/testing/templateDb'
import { emptyDrainGate } from '../../wiring/emptyDrainGate'
import { createHostDispatcher } from '../../wiring/hostDispatcher'
import { HelloThrottle } from '../auth/throttle'
import { UI_TOKEN_FILE, UiToken } from '../auth/uiToken'
import { collectCapabilities } from '../capabilities'
import { acceptConnection } from '../connection'
import { ConnectionRegistry } from '../connectionRegistry'
import { BOARD_FRAMES, publishBoardFrames } from '../frames/board'
import { createUpgradeDrain } from '../lifecycle/drain'
import { HostStateHolder } from '../lifecycle/hostState'
import { NO_LEDGER_TOTALS } from '../mappers/wire'
import { SectionRegistry } from '../snapshot/sectionRegistry'
import { FrameClient } from '../testing/frameClient'
import { inProcessDuplex } from '../testing/inProcessDuplex'
import { createUpgradeTargetRule } from './hostUpgradeRequest'
import { registerMineRemoval, registerMines } from './mines'

type HostEvent = MinesEvent | CrewEvent | CrewEndEvent | ObservationEvent

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

const EPOCH = 'epoch-0080'
const T0 = 1_790_000_000_000

const uuid = (n: number): string => `01890a5d-ac96-774b-bcce-${n.toString(16).padStart(12, '0')}`

function validateFrame(name: string, data: unknown): void {
  const schemas: Readonly<Record<string, z.ZodTypeAny | undefined>> = HOST_FRAME_SCHEMAS
  const schema = schemas[name]
  if (schema === undefined) throw new Error(`no contract schema for ${name}`)
  schema.parse(data)
}

/** A SessionTerminator double whose ends wait until the test settles them, or answer at once. */
class GatedTerminator implements SessionTerminator {
  readonly calls: Array<{ dwarfId: DwarfId; why: EndReason }> = []
  readonly outcomes = new Map<DwarfId, EndOutcome>()
  gated = false
  private readonly gates: Array<() => void> = []

  end(dwarfId: DwarfId, why: EndReason): Promise<EndOutcome> {
    this.calls.push({ dwarfId, why })
    const outcome = this.outcomes.get(dwarfId) ?? { kind: 'ended' }
    if (!this.gated) return Promise.resolve(outcome)
    return new Promise((resolve) => this.gates.push(() => resolve(outcome)))
  }

  endAll(): Promise<Map<DwarfId, EndOutcome>> {
    return Promise.reject(new Error('Remove mine ends dwarf by dwarf'))
  }

  /** Lets every waiting end answer. */
  release(): void {
    for (const open of this.gates.splice(0)) open()
  }
}

/** One Host transport serving B-M18 over the mines and crew modules, with the board frames. */
async function host() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dwarfai-080-remove-')))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const token = new UiToken()
  await token.issue(root)
  const secret = readFileSync(join(root, UI_TOKEN_FILE), 'utf8')
  const clock = new FakeClock(T0)
  const scheduler = new FakeScheduler(clock)
  const log = new RecordingDiagnosticsLog()
  const connections = new ConnectionRegistry({ validateFrame })
  const state = new HostStateHolder(connections)
  state.report({ state: 'ready', jobStatus: 'none' })
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
    sections: new SectionRegistry(),
    snapshotMeta: {
      hostVersion: () => '0.21.0',
      state: () => state.current().state,
      resetEpoch: () => 0,
      snapshotTail: () => 20,
      minesEverKnown: () => true
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

  const { db } = openTemplateCopy()
  const transactions = new SqliteTransactionRunner(db)
  const bus = new RecordingEventBus<HostEvent>({ transactionScope: transactions })
  const mines = createMines({
    db,
    transactions,
    mapSites: [{ xPct: 10, yPct: 20 }],
    random: () => 0,
    fs: new NodeFs(),
    clock,
    ids,
    bus,
    hostEpoch: EPOCH,
    remeasure: () => undefined
  })
  const crew = createCrew({
    db,
    transactions,
    lifecycleFacts: new SqliteLifecycleFactLog({ db, scope: transactions, ids, clock }),
    bus,
    clock,
    scheduler,
    ids,
    hostEpoch: EPOCH,
    links: { owned: () => false, hasDeliveryRoute: () => false }
  })
  const terminator = new GatedTerminator()
  const aborted: MineId[] = []
  registerMines(dispatcher, { mines: mines.queries, commands: mines.commands })
  registerMineRemoval(
    dispatcher,
    mines.removal({
      crew: crew.ends({ terminator, bus }),
      abortWalk: (mineId) => aborted.push(mineId)
    })
  )
  publishBoardFrames({
    events: { mines: bus, crew: bus, observation: bus },
    mines: mines.queries,
    crew: crew.queries,
    ledger: NO_LEDGER_TOTALS,
    frames: connections
  })

  const throttle = new HelloThrottle(clock)
  const pair = inProcessDuplex()
  acceptConnection(pair.host, {
    token,
    ids,
    identity: { hostVersion: '0.21.0', buildId: 'abc1234', protocolVersion: PROTOCOL_VERSION },
    epoch: EPOCH,
    state: () => state.current(),
    capabilities: () =>
      collectCapabilities({ methods: dispatcher.methods(), frames: BOARD_FRAMES, sections: [] }),
    scheduler,
    clock,
    log,
    dispatcher,
    connections,
    throttle
  })
  const ui = new FrameClient(pair.client)
  cleanups.push(() => void pair.client.destroy())
  ui.send({
    type: 'hello',
    endpointGeneration: 1,
    protocolVersion: PROTOCOL_VERSION,
    role: 'ui',
    token: secret,
    client: { appVersion: '0.21.0', buildId: 'abc1234', pid: 4242 }
  })
  await ui.settle()
  expect(ui.frames[0]).toMatchObject({ type: 'hello.ok' })

  /** A declared mine at a real folder, with one present observed dwarf per session. */
  const mineWith = async (sessions: string[]) => {
    const declared = await mines.commands.declare(root as FolderPath)
    if (!declared.ok || !('mineId' in declared.value)) throw new Error('no mine declared')
    const mineId = declared.value.mineId
    const dwarfs = sessions.map((session) =>
      crew.commands.arrive({
        mineId,
        identity: { providerId: 'claude', providerSessionId: session },
        rank: 'foreman',
        status: 'working'
      })
    )
    await ui.settle()
    return { mineId, dwarfs }
  }
  return { ui, bus, crew, mines, terminator, aborted, mineWith }
}

let nextId = 0

type Res = z.infer<typeof resFrameSchema>

/** Sends one request; returns its id. */
function request(client: FrameClient, method: string, params: unknown): string {
  nextId += 1
  const id = `req-${nextId}`
  client.send({ type: 'req', id, method, params })
  return id
}

function isRes(frame: unknown, id: string): boolean {
  return (
    (frame as { type?: string; id?: string }).type === 'res' && (frame as { id?: string }).id === id
  )
}

/** Waits for the `res` of request `id` and returns it. */
async function response(client: FrameClient, id: string): Promise<Res> {
  await client.until(() => client.frames.some((frame) => isRes(frame, id)))
  return resFrameSchema.parse(client.frames.find((frame) => isRes(frame, id)))
}

/** The contract result of an answered `mines.remove`, validated by its schema. */
function resultOf(res: Res): unknown {
  expect(res.ok ? undefined : res.error.code).toBeUndefined()
  return res.ok ? HOST_METHOD_SCHEMAS['mines.remove'].result.parse(res.result) : undefined
}

/** Each frame received from index `from` on, as `evt <name>` with its data, or `res <id>`. */
function wire(client: FrameClient, from: number): Array<{ name: string; data?: unknown }> {
  return client.frames.slice(from).flatMap((frame) => {
    const type = (frame as { type?: string }).type
    if (type === 'evt') {
      const evt = evtFrameSchema.parse(frame)
      return [{ name: evt.name, data: evt.data }]
    }
    if (type === 'res') return [{ name: `res ${(frame as { id?: string }).id ?? ''}` }]
    return []
  })
}

describe('mines.remove over seam B (14 §2.3 B-M18)', () => {
  it('[ADR-014] mines.remove answers after every end settled and every frame of the removal, mine.removed last, precedes the response', async () => {
    const h = await host()
    const { mineId, dwarfs } = await h.mineWith(['s-borin', 's-dain'])
    h.terminator.gated = true
    const from = h.ui.frames.length

    const id = request(h.ui, 'mines.remove', { mineId, requestId: uuid(1) })
    await h.ui.until(() => h.terminator.calls.length === 2)
    await h.ui.settle()
    // Both ends are running: no answer yet, and no frame of the outcome.
    expect(wire(h.ui, from)).toEqual([])
    h.terminator.release()
    const res = await response(h.ui, id)

    expect(resultOf(res)).toEqual({ ok: true, value: {} })
    expect(h.terminator.calls).toEqual(dwarfs.map((dwarfId) => ({ dwarfId, why: 'remove-mine' })))
    expect(h.aborted).toEqual([mineId])
    expect(wire(h.ui, from)).toEqual([
      ...dwarfs.map((dwarfId) => ({
        name: 'dwarf.departed',
        data: { dwarfId, mineId, cause: 'mine-removed' }
      })),
      { name: 'mine.removed', data: { mineId, removedAt: T0 } },
      { name: `res ${id}` }
    ])
    expect(h.mines.queries.get(mineId)).toBeNull()
    expect(h.bus.handlerErrors).toEqual([])
  })

  it('[ADR-014] a partial removal sends exactly one toast mine-removal-failed and no per-dwarf toast', async () => {
    const h = await host()
    const { mineId, dwarfs } = await h.mineWith(['s-borin', 's-dain', 's-thrain'])
    const [borin, dain, thrain] = dwarfs as [DwarfId, DwarfId, DwarfId]
    h.terminator.outcomes.set(dain, { kind: 'failed', reason: 'no-identity' })
    h.terminator.outcomes.set(thrain, { kind: 'failed', reason: 'still-alive' })
    const from = h.ui.frames.length
    const requestId = uuid(2)

    const id = request(h.ui, 'mines.remove', { mineId, requestId })
    const res = await response(h.ui, id)

    expect(resultOf(res)).toEqual({ ok: false, error: 'dwarf-could-not-be-ended' })
    expect(wire(h.ui, from)).toEqual([
      { name: 'dwarf.departed', data: { dwarfId: borin, mineId, cause: 'mine-removed' } },
      {
        name: 'toast',
        data: { kind: 'mine-removal-failed', requestId, mineId, failed: [dain, thrain] }
      },
      { name: `res ${id}` }
    ])
    // The mine stays on the board with only the dwarfs still running (US-MINES-006.AC09).
    expect(h.mines.queries.get(mineId)?.state).toBe('measuring')
    expect(h.crew.queries.crewOf(mineId).map((dwarf) => dwarf.id)).toEqual([dain, thrain])
    expect(h.bus.ofType('DwarfStopFailed')).toHaveLength(2)
  })

  it('[ADR-003] a repeated requestId returns the first result with one effect', async () => {
    const h = await host()
    const { mineId } = await h.mineWith(['s-borin'])
    const requestId = uuid(3)

    const first = resultOf(
      await response(h.ui, request(h.ui, 'mines.remove', { mineId, requestId }))
    )
    const from = h.ui.frames.length
    const again = request(h.ui, 'mines.remove', { mineId, requestId })
    const second = resultOf(await response(h.ui, again))

    expect(second).toEqual(first)
    expect(first).toEqual({ ok: true, value: {} })
    expect(h.terminator.calls).toHaveLength(1)
    expect(h.bus.ofType('MineRemoved')).toHaveLength(1)
    expect(wire(h.ui, from)).toEqual([{ name: `res ${again}` }])
  })
})
