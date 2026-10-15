// layer: L2
// L2 (17 §1.2): launching's `stopAll` (05 §3.5; 16 §4.5 row `stopAll`; ADR-002 D7 step 3; ADR-014
// item 9; ADR-015 item 8; 07 S12.11, S12.21, S4.05, S4.07; 13 FM-143, FM-144; 06 INV-120, INV-121)
// over the in-memory launching stores, a recording crew `endOwned` and a scripted in-flight gate:
// it waits for the launches in flight, marks every live record stopped with no resume intent,
// asks crew to end exactly the owned dwarfs, and publishes one `StopAllIncomplete` only when an
// end failed. It also runs the StopAllPort conformance suite (16 §2.8, 17 §1.3).
//
// TC-175-01, TC-175-02, TC-175-03.
import { describe, expect, it } from 'vitest'
import type { DwarfId, FolderPath, HostEpoch, LaunchId } from '../../../kernel/domain/values'
import type { DrainBlocker, DrainGate } from '../../../kernel/ports/drainGate'
import { RecordingEventBus } from '../../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import { runStopAllContract } from '../../../kernel/testing/stopAll.contract'
import type { LaunchRecord } from '../ports/launchRecordStore'
import { inMemoryLaunching } from '../testing/inMemoryLaunching'
import { StopAll, type LaunchSettlements, type StopAllIncomplete } from './stopAll'

const EPOCH = 'epoch-175' as HostEpoch
const REQUEST = '01890a5d-ac96-774b-bcce-000000001751'

const dwarfOf = (n: number): DwarfId => `00000000-0000-7000-8000-0000000175d${n}` as DwarfId
const launchOf = (n: number): LaunchId => `00000000-0000-7000-8000-0000000175a${n}` as LaunchId

function record(n: number, extra: Partial<LaunchRecord> = {}): LaunchRecord {
  return {
    dwarfId: dwarfOf(n),
    launchId: launchOf(n),
    ref: { providerId: 'claude', providerSessionId: `session-${n}` },
    driverTransport: 'stream-json',
    cwd: '/work/mine-one' as FolderPath,
    launchOptions: {
      providerId: 'claude',
      model: 'model-x',
      effort: 'high',
      permissionMode: 'ask'
    },
    launchedWithLetJevChoose: false,
    resumeIntent: true,
    stoppedByPerson: false,
    hostEpoch: EPOCH,
    ...extra
  }
}

/** A crew `endOwned` double: what each call was asked and saw, and the scripted failures. */
class RecordingOwnedEnds {
  readonly calls: Array<{ dwarfIds: DwarfId[]; requestId: string; records: LaunchRecord[] }> = []
  failing = new Set<DwarfId>()

  constructor(private readonly records: () => LaunchRecord[]) {}

  endOwned(dwarfIds: DwarfId[], requestId: string) {
    this.calls.push({ dwarfIds: [...dwarfIds], requestId, records: this.records() })
    return Promise.resolve({
      ended: dwarfIds.filter((dwarfId) => !this.failing.has(dwarfId)),
      failed: dwarfIds.filter((dwarfId) => this.failing.has(dwarfId))
    })
  }
}

/** The in-flight launches as the launching drain gate reports them, settled by the test. */
class ScriptedInFlight implements DrainGate, LaunchSettlements {
  inFlight = 0
  private readonly listeners = new Set<() => void>()

  blockers(): readonly DrainBlocker[] {
    return Array.from({ length: this.inFlight }, (): DrainBlocker => ({ kind: 'in-flight' }))
  }

  onSettled(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  settleOne(): void {
    this.inFlight -= 1
    for (const listener of [...this.listeners]) listener()
  }
}

function world(seeded: LaunchRecord[] = []) {
  const db = inMemoryLaunching()
  db.inTransaction(() => {
    for (const r of seeded) db.records.put(r)
  })
  const crew = new RecordingOwnedEnds(() => db.records.all())
  const launches = new ScriptedInFlight()
  const bus = new RecordingEventBus<StopAllIncomplete>()
  const stopAll = new StopAll({
    records: db.records,
    transactions: { inTransaction: (work) => db.inTransaction(work) },
    inFlight: launches,
    settlements: launches,
    crew,
    bus,
    clock: db.clock,
    ids: new SequenceIdGenerator(),
    hostEpoch: EPOCH
  })
  return { db, crew, launches, bus, stopAll }
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 20; turn++) await Promise.resolve()
}

describe('LaunchCommands.stopAll (16 §4.5)', () => {
  runStopAllContract(() => {
    const w = world([record(1), record(2)])
    return { port: w.stopAll, owned: [dwarfOf(1), dwarfOf(2)] }
  })

  it('[INV-120, S12.11] stopAll asks crew to end exactly the dwarfs of the live launch records, with its requestId', async () => {
    const w = world([record(1), record(2), record(3, { endedAt: 1 as LaunchRecord['endedAt'] })])

    const outcome = await w.stopAll.stopAll(REQUEST)

    expect(w.crew.calls.map(({ dwarfIds, requestId }) => ({ dwarfIds, requestId }))).toEqual([
      { dwarfIds: [dwarfOf(1), dwarfOf(2)], requestId: REQUEST }
    ])
    expect(outcome).toEqual({ ended: [dwarfOf(1), dwarfOf(2)], failed: [] })
  })

  it('[ADR-015, S4.05] before any end runs, every live record is stopped by the person and has no resume intent', async () => {
    const w = world([record(1), record(2)])

    await w.stopAll.stopAll(REQUEST)

    expect(
      w.crew.calls[0]?.records.map(({ dwarfId, stoppedByPerson, resumeIntent }) => ({
        dwarfId,
        stoppedByPerson,
        resumeIntent
      }))
    ).toEqual([
      { dwarfId: dwarfOf(1), stoppedByPerson: true, resumeIntent: false },
      { dwarfId: dwarfOf(2), stoppedByPerson: true, resumeIntent: false }
    ])
  })

  it('[INV-121, US-RES-002.AC09] when every end succeeded, stopAll publishes nothing', async () => {
    const w = world([record(1)])

    const outcome = await w.stopAll.stopAll(REQUEST)

    expect(outcome).toEqual({ ended: [dwarfOf(1)], failed: [] })
    expect(w.bus.published).toEqual([])
  })

  it('[FM-143, S12.21, S4.07] a failed end publishes one StopAllIncomplete naming it, and its record is no longer stopped by the person and keeps its resume intent', async () => {
    const w = world([record(1), record(2)])
    w.crew.failing.add(dwarfOf(2))

    const outcome = await w.stopAll.stopAll(REQUEST)

    expect(outcome).toEqual({ ended: [dwarfOf(1)], failed: [dwarfOf(2)] })
    expect(w.bus.published).toHaveLength(1)
    expect(w.bus.published[0]).toMatchObject({
      type: 'StopAllIncomplete',
      v: 1,
      hostEpoch: EPOCH,
      payload: { requestId: REQUEST, ended: [dwarfOf(1)], failed: [dwarfOf(2)] }
    })
    expect(w.db.records.live().find((r) => r.dwarfId === dwarfOf(2))).toMatchObject({
      stoppedByPerson: false,
      resumeIntent: true
    })
    expect(w.db.records.live().find((r) => r.dwarfId === dwarfOf(1))).toMatchObject({
      stoppedByPerson: true,
      resumeIntent: false
    })
  })

  it('[FM-144] a launch in flight holds stopAll until it settles, then its dwarf is ended with the others', async () => {
    const w = world([record(1)])
    w.launches.inFlight = 1
    let answered = false

    const running = w.stopAll.stopAll(REQUEST).then((outcome) => {
      answered = true
      return outcome
    })
    await flush()
    expect(w.crew.calls).toEqual([])
    expect(answered).toBe(false)

    // The launch succeeds: its owned session's record is live when it settles.
    w.db.inTransaction(() => w.db.records.put(record(2)))
    w.launches.settleOne()

    expect(await running).toEqual({ ended: [dwarfOf(1), dwarfOf(2)], failed: [] })
    expect(w.crew.calls.map(({ dwarfIds }) => dwarfIds)).toEqual([[dwarfOf(1), dwarfOf(2)]])
  })

  it('[ADR-002] a repeat of the same requestId while the first is in flight joins it, so crew is asked once', async () => {
    const w = world([record(1)])
    w.launches.inFlight = 1

    const first = w.stopAll.stopAll(REQUEST)
    const repeat = w.stopAll.stopAll(REQUEST)
    w.launches.settleOne()

    expect(await repeat).toEqual(await first)
    expect(w.crew.calls).toHaveLength(1)
  })
})
