// layer: L3
// Launching's half of `DriverSessionExited` (05 §4; 08 §2.4, §2.5; 07 S4.06, S4.08; PO #62) over
// the in-memory launching stores, a RecordingEventBus and a RecordingDiagnosticsLog. Each
// condition of the PO #62 check is proven on its own: owned, no pending end, not stopped by the
// person, not covered by the current Host recovery (and the dwarf still present, UC-021).
import { describe, expect, it } from 'vitest'
import type {
  DwarfId,
  FolderPath,
  HostEpoch,
  LaunchId,
  ProviderId
} from '../../../kernel/domain/values'
import { RecordingDiagnosticsLog } from '../../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingEventBus } from '../../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import type { EndReason } from '../../crew'
import type { LaunchRecord } from '../ports/launchRecordStore'
import { inMemoryLaunching } from '../testing/inMemoryLaunching'
import type { LaunchingEvent } from './events'
import { SessionExitedCheck, type SessionExit } from './sessionExited'

const T0 = 1_790_000_000_000
const EPOCH = 'epoch-176' as HostEpoch
const DWARF = '00000000-0000-7000-8000-0000000176d1' as DwarfId
const LAUNCH = '00000000-0000-7000-8000-0000000176e1' as LaunchId
const SIMULATED = 'simulated' as ProviderId

const RECORD: LaunchRecord = {
  dwarfId: DWARF,
  launchId: LAUNCH,
  ref: { providerId: SIMULATED, providerSessionId: 'sim-176' },
  driverTransport: 'acp',
  cwd: '/work/deep-seam' as FolderPath,
  launchOptions: { providerId: SIMULATED },
  launchedWithLetJevChoose: false,
  resumeIntent: true,
  stoppedByPerson: false,
  hostEpoch: EPOCH
}

function subject(options: { record?: Partial<LaunchRecord> | null; covered?: boolean } = {}) {
  const db = inMemoryLaunching(T0)
  const bus = new RecordingEventBus<LaunchingEvent>()
  const log = new RecordingDiagnosticsLog()
  if (options.record !== null) {
    db.inTransaction(() => db.records.put({ ...RECORD, ...options.record }))
  }
  const check = new SessionExitedCheck({
    records: db.records,
    transactions: { inTransaction: (work) => db.inTransaction(work) },
    recovery: { covers: (dwarfId) => options.covered === true && dwarfId === DWARF },
    bus,
    clock: db.clock,
    ids: new SequenceIdGenerator(),
    hostEpoch: EPOCH,
    log
  })
  db.clock.advance(5_000)
  return { db, bus, log, check }
}

const exit = (pendingEnd: EndReason | null = null, present = true): SessionExit => ({
  dwarfId: DWARF,
  pendingEnd,
  present
})

describe('launching on a driver exit (PO #62 check)', () => {
  it('[S4.08, FM-058, US-RES-001.AC02] an owned session nobody stopped publishes one LaunchedSessionCrashed and its record ends', () => {
    const { db, bus, log, check } = subject()

    expect(check.exited(exit())).toEqual({ owned: true, covered: false, crashed: true })

    expect(bus.ofType('LaunchedSessionCrashed').map((e) => e.payload)).toEqual([
      { dwarfId: DWARF, launchId: LAUNCH }
    ])
    expect(bus.ofType('LaunchedSessionCrashed')[0]).toMatchObject({
      v: 1,
      at: T0 + 5_000,
      hostEpoch: EPOCH
    })
    expect(db.records.live()).toEqual([])
    expect(db.records.all()).toEqual([{ ...RECORD, endedAt: T0 + 5_000, resumeIntent: false }])
    expect(log.byEvent('session.crashed')).toMatchObject([
      { level: 'warn', subsystem: 'launching', dwarfId: DWARF, launchId: LAUNCH }
    ])
  })

  it('[INV-30, BR-08, US-OBS-007.AC07] a session with no live LaunchRecord is not owned: nothing is published or written', () => {
    const { db, bus, log, check } = subject({ record: null })

    expect(check.exited(exit())).toEqual({ owned: false, covered: false, crashed: false })

    expect(bus.published).toEqual([])
    expect(db.records.all()).toEqual([])
    expect(log.byEvent('session.crashed')).toEqual([])
  })

  it('[INV-30] an ended record is not owned any more: a second exit publishes nothing', () => {
    const { db, bus, check } = subject()
    check.exited(exit())

    expect(check.exited(exit())).toEqual({ owned: false, covered: false, crashed: false })

    expect(bus.ofType('LaunchedSessionCrashed')).toHaveLength(1)
    expect(db.records.all()).toMatchObject([{ endedAt: T0 + 5_000 }])
  })

  it('[S4.06, ADR-014] an end the Host asked for publishes nothing; the record ends with no resume intent', () => {
    for (const why of ['stop-dwarf', 'stop-all', 'remove-mine', 'delegation-done'] as const) {
      const { db, bus, check } = subject()

      expect(check.exited(exit(why))).toEqual({ owned: true, covered: false, crashed: false })

      expect(bus.published).toEqual([])
      expect(db.records.all()).toEqual([{ ...RECORD, endedAt: T0 + 5_000, resumeIntent: false }])
    }
  })

  it('[US-RES-001.AC04, FM-060] a session the person stopped publishes nothing even when no end is pending any more', () => {
    const { db, bus, check } = subject({ record: { stoppedByPerson: true } })

    expect(check.exited(exit())).toEqual({ owned: true, covered: false, crashed: false })

    expect(bus.published).toEqual([])
    expect(db.records.all()).toEqual([
      { ...RECORD, stoppedByPerson: true, endedAt: T0 + 5_000, resumeIntent: false }
    ])
  })

  it('[ADR-015] a dwarf the current Host recovery covers publishes nothing and keeps its record', () => {
    const { db, bus, check } = subject({ covered: true })

    expect(check.exited(exit())).toEqual({ owned: true, covered: true, crashed: false })

    expect(bus.published).toEqual([])
    expect(db.records.live()).toEqual([RECORD])
  })

  it('[ADR-014] a host-recovery end publishes nothing and keeps the record: the resume follows', () => {
    const { db, bus, check } = subject()

    expect(check.exited(exit('host-recovery'))).toEqual({
      owned: true,
      covered: false,
      crashed: false
    })

    expect(bus.published).toEqual([])
    expect(db.records.live()).toEqual([RECORD])
  })

  it('[INV-26] a dwarf that already left its mine is not reported; its record ends', () => {
    const { db, bus, check } = subject()

    expect(check.exited(exit(null, false))).toEqual({
      owned: true,
      covered: false,
      crashed: false
    })

    expect(bus.published).toEqual([])
    expect(db.records.live()).toEqual([])
  })
})
