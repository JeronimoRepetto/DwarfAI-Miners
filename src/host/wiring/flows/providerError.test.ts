// layer: L2
// L2 flow (17 §1.2; 12 UC-031 "provider error", the observed half; 13 FM-067, FM-068): observation,
// mines and crew composed through their public index.ts over one copy of the template database,
// with the board frames of the transport (frames/board.ts) and the 05 §4 routes of this flow
// declared here, as `host/wiring` will declare them (later: ISSUE-093…ISSUE-095):
//
// - `SessionObserved` → `mines.resolveForSession(cwd, firstMessage)` → `crew.arrive` on `{ mineId }`;
// - `SessionClosedObserved` → `crew.sessionClosed(…, 'closed-elsewhere')` (08 §2.3; S2.06);
// - `ProviderErrorObserved` → the transport's `toast {kind: 'provider-error'}` (board.ts, B-F28) and
//   diagnostics (05 §4). No production diagnostics route exists yet, so it is composed here as one
//   `DiagnosticsLog` record per event (19 §6 fields: cause class, provider, dwarf id; the writer
//   stamps `ts`); the production route lands with the wiring (later: ISSUE-095). The mines
//   `checkFolder` of the same route is ISSUE-085's (mineFolderGone.test.ts).
//
// The provider is the simulated one behind a test adapter that can stop answering: while it fails,
// every read throws an error carrying the provider's own text, as a provider that stops responding
// does (FM-067). Observation counts those reads as drift and, past its threshold, reports the
// provider error once (domain/providerError.ts).
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { HOST_FRAME_SCHEMAS, type HostFrameData, type HostFrameName } from '@dwarfai/contracts'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingEventBus } from '../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import type { DwarfId, FolderPath } from '../../kernel/domain/values'
import { createCrew, type CrewEvent } from '../../modules/crew'
import { createMines, type MinesEvent } from '../../modules/mines'
import {
  OBSERVATION_POLL_MS,
  createObservation,
  createSqliteObservationStores,
  type ObservationEvent
} from '../../modules/observation'
import {
  SimulatedObservationAdapter,
  SimulatedSessionLog
} from '../../modules/observation/adapters/simulated/SimulatedObservationAdapter'
import { NodeFs } from '../../platform/fs/NodeFs'
import { SqliteLifecycleFactLog } from '../../platform/sqlite/SqliteLifecycleFactLog'
import { SqliteTransactionRunner } from '../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../platform/sqlite/testing/templateDb'
import { NO_LEDGER_TOTALS } from '../../transport/mappers/wire'
import { publishBoardFrames } from '../../transport/frames/board'

type HostEvent = ObservationEvent | MinesEvent | CrewEvent

const T0 = 1_790_000_000_000
const EPOCH = 'epoch-0084'
const SIMULATED = 'simulated'
/** The typed causes of an observed provider error (13 FM-067, FM-068; 16 §2.1). */
const TYPED_CAUSES = ['provider-error', 'rate-limited', 'auth-required', 'unreadable']
/** Polls a provider error may take to surface: observation counts drift first (ADR-026 item 6). */
const MAX_POLLS = 10
/** What the provider says when it fails: it must reach no frame and no log (ADR-026 item 4). */
const PROVIDER_TEXT = 'Overloaded: quota exceeded for organization sample-org'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** The simulated provider, which stops answering while `failing` holds (FM-067). */
class FailingProvider extends SimulatedObservationAdapter {
  failing = false

  override read(
    ...args: Parameters<SimulatedObservationAdapter['read']>
  ): ReturnType<SimulatedObservationAdapter['read']> {
    if (this.failing) {
      return Promise.reject(Object.assign(new Error(PROVIDER_TEXT), { code: 'E_PROVIDER' }))
    }
    return super.read(...args)
  }
}

/** The frames the transport sends, each checked against its 14 §3.5 strict() schema. */
class RecordingFrames {
  readonly sent: Array<{ name: string; data: unknown }> = []

  publishFrame<F extends HostFrameName>(name: F, data: HostFrameData[F]): void {
    const schemas: Readonly<Record<string, z.ZodTypeAny | undefined>> = HOST_FRAME_SCHEMAS
    schemas[name]?.parse(data)
    this.sent.push({ name, data })
  }

  names(): string[] {
    return this.sent.map((frame) => frame.name)
  }
}

/** The composed Host slice over a template copy, with the 05 §4 routes of this flow. */
async function host() {
  const root = realpathSync.native(await mkdtemp(join(tmpdir(), 'dwarfai-provider-error-')))
  roots.push(root)
  const { db } = openTemplateCopy()
  const transactions = new SqliteTransactionRunner(db)
  const clock = new FakeClock(T0)
  const scheduler = new FakeScheduler(clock)
  const ids = new SequenceIdGenerator()
  const bus = new RecordingEventBus<HostEvent>({ transactionScope: transactions })
  const fs = new NodeFs()
  const log = new RecordingDiagnosticsLog()

  const mines = createMines({
    db,
    transactions,
    mapSites: [{ xPct: 10, yPct: 20 }],
    random: () => 0,
    fs,
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
  const sessions = new SimulatedSessionLog()
  const provider = new FailingProvider({ providerId: SIMULATED, log: sessions })
  const stores = createSqliteObservationStores({ db, scope: transactions, clock })
  const observation = createObservation({
    adapters: [provider],
    fs,
    ...stores,
    sink: { apply: () => undefined },
    transactions,
    bus,
    clock,
    scheduler,
    ids,
    hostEpoch: EPOCH,
    log
  })
  const frames = new RecordingFrames()
  publishBoardFrames({
    events: { mines: bus, crew: bus, observation: bus },
    mines: mines.queries,
    crew: crew.queries,
    ledger: NO_LEDGER_TOTALS,
    frames
  })

  // The 05 §4 routes of this flow.
  const routes = new Set<Promise<unknown>>()
  const track = (route: Promise<unknown>) => {
    routes.add(route)
    void route.finally(() => routes.delete(route))
  }
  bus.subscribe('SessionObserved', ({ payload }) => {
    track(
      (async () => {
        const firstMessage = payload.firstMessage ?? false
        const resolved = await mines.commands.resolveForSession(payload.cwd, firstMessage)
        if (!('mineId' in resolved)) return
        crew.commands.arrive({
          mineId: resolved.mineId,
          identity: payload.identity,
          rank: 'foreman',
          status: firstMessage ? 'working' : 'idle'
        })
      })()
    )
  })
  bus.subscribe('SessionClosedObserved', ({ payload }) => {
    const dwarfId = stores.sessions.byIdentity(payload.identity)?.dwarfId
    if (dwarfId !== undefined) crew.commands.sessionClosed(dwarfId, 'closed-elsewhere')
  })
  // Diagnostics' half of the route (05 §4; 19 §6): one record per provider error, the cause class
  // and ids only (later: ISSUE-095 composes it in host/wiring).
  bus.subscribe('ProviderErrorObserved', ({ payload }) => {
    log.record({
      level: 'warn',
      event: 'observation.provider-error',
      subsystem: 'observation',
      provider: payload.providerId,
      causeClass: payload.cause,
      ...(payload.dwarfId === undefined ? {} : { dwarfId: payload.dwarfId }),
      outcome: 'failed',
      msg: 'a provider of an observed session errored or became unreadable'
    })
  })

  /** Every cycle and every route it caused has settled. */
  const settle = async () => {
    for (let n = 0; n < 10; n++) {
      await observation.whenIdle()
      if (routes.size === 0) return
      await Promise.all([...routes])
    }
  }
  /** One poll of the loop, then everything it caused. */
  const poll = async () => {
    await settle()
    clock.advance(OBSERVATION_POLL_MS)
    await settle()
  }
  /** A dwarf working in a fresh folder: its session's first message makes the mine and the dwarf. */
  const working = async (sessionId: string): Promise<DwarfId> => {
    const cwd = join(root, sessionId) as FolderPath
    await mkdir(cwd, { recursive: true })
    sessions.open(sessionId, cwd, clock.now())
    sessions.message(sessionId, 'person', 'Dig the north seam', clock.now())
    await poll()
    const dwarfId = stores.sessions.byIdentity({
      providerId: SIMULATED,
      providerSessionId: sessionId
    })?.dwarfId
    if (dwarfId === undefined) throw new Error(`no dwarf arrived for ${sessionId}`)
    return dwarfId
  }
  /** The provider stops answering until observation reports it; how many polls that took. */
  const providerFails = async (): Promise<number> => {
    provider.failing = true
    const reported = bus.ofType('ProviderErrorObserved').length
    for (let n = 1; n <= MAX_POLLS; n++) {
      await poll()
      if (bus.ofType('ProviderErrorObserved').length > reported) return n
    }
    throw new Error(`no provider error after ${MAX_POLLS} polls`)
  }
  const providerRecovers = () => {
    provider.failing = false
  }
  const toasts = () =>
    frames.sent.filter((frame) => frame.name === 'toast').map((frame) => frame.data)
  return {
    clock,
    bus,
    crew,
    sessions,
    observation,
    frames,
    log,
    poll,
    working,
    providerFails,
    providerRecovers,
    toasts
  }
}

describe('a provider errors under an observed dwarf (UC-031, observed half)', () => {
  it('[US-RES-004.AC02] when the session survives the error the dwarf keeps its status and no errored state exists', async () => {
    const h = await host()
    h.observation.control.start()
    const dwarf = await h.working('s1')
    expect(h.crew.queries.get(dwarf)?.status).toBe('working')
    const before = h.frames.sent.length

    await h.providerFails()

    // One toast, and nothing else about the dwarf: no status change, no departure.
    expect(h.frames.names().slice(before)).toEqual(['toast'])
    expect(h.toasts()).toEqual([
      { kind: 'provider-error', providerId: SIMULATED, cause: 'unreadable', dwarfId: dwarf }
    ])
    expect(h.crew.queries.get(dwarf)).toMatchObject({ departed: false, status: 'working' })
    expect(h.bus.ofType('DwarfStatusChanged')).toEqual([])

    // The session survives: the provider answers again and the dwarf goes on with nothing to clear.
    h.providerRecovers()
    h.sessions.message('s1', 'dwarf', 'Digging.', h.clock.now())
    await h.poll()
    expect(h.crew.queries.get(dwarf)).toMatchObject({ departed: false, status: 'working' })
    expect(h.toasts()).toHaveLength(1)
    h.observation.control.stop()
  })

  it('[US-RES-004.AC03] when the session does not survive the dwarf departs by the ordinary rule after the toast', async () => {
    const h = await host()
    h.observation.control.start()
    const dwarf = await h.working('s1')

    await h.providerFails()
    // The session ended meanwhile; once its ending is read, the ordinary departure applies on top.
    h.sessions.close('s1', h.clock.now())
    h.providerRecovers()
    await h.poll()

    expect(h.bus.ofType('DwarfDeparted').map((event) => event.payload)).toEqual([
      expect.objectContaining({ dwarfId: dwarf, cause: 'closed-elsewhere' })
    ])
    // The toast first, then the walk-out, as for any other outside closure (US-OBS-005).
    expect(
      h.frames.names().filter((name) => name === 'toast' || name === 'dwarf.departed')
    ).toEqual(['toast', 'dwarf.departed'])
    h.observation.control.stop()
  })

  it("[ADR-026] the toast cause is a typed value and the provider's error text appears in no frame", async () => {
    const h = await host()
    h.observation.control.start()
    await h.working('s1')

    await h.providerFails()

    const causes = h.toasts().map((toast) => (toast as { cause: string }).cause)
    expect(causes).toHaveLength(1)
    expect(TYPED_CAUSES).toContain(causes[0])
    const sent = JSON.stringify(h.frames.sent)
    expect(sent).not.toContain('quota')
    expect(sent).not.toContain('E_PROVIDER')
    h.observation.control.stop()
  })

  it('[NFR-OBS-01, ADR-026] each provider error writes one diagnostics log record with its cause class, provider, dwarf id and timestamp, while the toast carries only the short cause', async () => {
    const h = await host()
    h.observation.control.start()
    const dwarf = await h.working('s1')

    const polls = await h.providerFails()

    const errors = h.bus.ofType('ProviderErrorObserved')
    expect(errors).toHaveLength(1)
    // The event is stamped by the Host clock; the writer adds the record's `ts` (ADR-026 item 3).
    expect(errors[0]!.at).toBe(h.clock.now())
    expect(h.log.byEvent('observation.provider-error')).toEqual([
      {
        level: 'warn',
        event: 'observation.provider-error',
        subsystem: 'observation',
        provider: SIMULATED,
        causeClass: 'unreadable',
        dwarfId: dwarf,
        outcome: 'failed',
        msg: 'a provider of an observed session errored or became unreadable'
      }
    ])
    // The failed reads left only their code; nothing the provider said is logged or refused.
    const drift = h.log.byEvent('observation.drift')
    expect(drift.map((record) => record.errCode)).toEqual(
      Array.from({ length: polls }, () => 'E_PROVIDER')
    )
    expect(JSON.stringify([h.log.entries, h.log.refused])).not.toContain('quota')
    // The toast holds the short cause and the ids, nothing more.
    expect(h.toasts()).toEqual([
      { kind: 'provider-error', providerId: SIMULATED, cause: 'unreadable', dwarfId: dwarf }
    ])
    h.observation.control.stop()
  })
})
