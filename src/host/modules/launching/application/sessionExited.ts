// Launching's half of `DriverSessionExited` (05 §4; 08 §2.4, §2.5; 07 S4.06, S4.08; 15 §1.4 row
// `exited`; 11 data flow row 12; UC-021; PO #62; ISSUE-176). The route (wiring/routes/launching.ts)
// calls it with the dwarf's pending end before crew's departure, and departs the dwarf with the
// cause `departureCause(pendingEnd, owned)` gives, from the `owned` answered here (INV-30).
//
// - Owned: the dwarf has a live `LaunchRecord` (no `endedAt`; glossary "Owned session"). A dwarf
//   with none is not launching's: nothing is written or published, whatever ended it (BR-08: the
//   same exit of an observed dwarf raises no toast).
// - Covered by the current Host recovery (resumed silently, or listed in its report; ADR-015 item
//   5; INV-58): nothing is written or published. The recovery owns that record and keeps the
//   dwarf in its mine (OQ-41 A); the exit observed is the old process's.
// - A `host-recovery` end (ADR-014 item 1): the resume follows, so the record stays as it is.
// - Otherwise the owned session has ended: its record gets `endedAt` and loses its resume intent
//   (09 §4.3 CHECK; ADR-015 item 8; S4.06, S4.08), in one transaction. Then, only when no end is
//   pending, the person did not stop it (`stopped_by_person = 0`, PO #62; FM-060) and the dwarf
//   is still in its mine (UC-021 precondition), `LaunchedSessionCrashed` is published after the
//   commit (16 §2.3) and one `session.crashed` warn record is logged with ids only (19 §7).
//
// `stoppedByPerson` is read even when no end is pending: the pending `why` is Host memory, forgotten
// when an end failed (S2.15) or the Host restarted, while the person's stop is persisted (16 §2.3,
// AR-24), so a stop never ends in the "stopped unexpectedly" toast.
import type { EndReason } from '../../crew'
import type { DwarfId, EventId, HostEpoch } from '../../../kernel/domain/values'
import type { Clock } from '../../../kernel/ports/clock'
import type { DiagnosticsLog } from '../../../kernel/ports/diagnosticsLog'
import type { DomainEventBus } from '../../../kernel/ports/domainEventBus'
import type { IdGenerator } from '../../../kernel/ports/idGenerator'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import type { LaunchRecordStore } from '../ports/launchRecordStore'
import type { LaunchingEvent } from './events'

/** The dwarfs the current Host recovery covers: resumed silently, or listed in its report. */
export interface RecoveryCoverage {
  covers(dwarfId: DwarfId): boolean
}

/** No Host recovery has run in this Host. */
export const NO_HOST_RECOVERY: RecoveryCoverage = Object.freeze({ covers: () => false })

/** What the route knows of the dwarf when its session's `exited` arrives. */
export interface SessionExit {
  dwarfId: DwarfId
  /** The `why` of the end the Host asked for (crew's pending end), or null. */
  pendingEnd: EndReason | null
  /** The dwarf is still in its mine (UC-021 precondition). */
  present: boolean
}

/** Whether the session was owned, covered by the current recovery, and reported crashed. */
export interface SessionExitResult {
  owned: boolean
  covered: boolean
  crashed: boolean
}

export interface SessionExitedDeps {
  records: LaunchRecordStore
  transactions: TransactionRunner
  recovery: RecoveryCoverage
  bus: Pick<DomainEventBus<LaunchingEvent>, 'publish'>
  clock: Clock
  ids: IdGenerator
  hostEpoch: HostEpoch
  log: DiagnosticsLog
}

const NOT_OWNED: SessionExitResult = Object.freeze({ owned: false, covered: false, crashed: false })

export class SessionExitedCheck {
  constructor(private readonly deps: SessionExitedDeps) {}

  exited(exit: SessionExit): SessionExitResult {
    const { records, transactions, clock } = this.deps
    const record = records.live().find((live) => live.dwarfId === exit.dwarfId)
    if (record === undefined) return { ...NOT_OWNED }
    if (this.deps.recovery.covers(exit.dwarfId)) {
      return { owned: true, covered: true, crashed: false }
    }
    if (exit.pendingEnd === 'host-recovery') return { owned: true, covered: false, crashed: false }

    const at = clock.now()
    transactions.inTransaction(() => records.put({ ...record, endedAt: at, resumeIntent: false }))
    const crashed = exit.pendingEnd === null && !record.stoppedByPerson && exit.present
    if (!crashed) return { owned: true, covered: false, crashed: false }

    const { dwarfId, launchId } = record
    this.deps.log.record({
      level: 'warn',
      event: 'session.crashed',
      subsystem: 'launching',
      dwarfId,
      launchId
    })
    this.deps.bus.publish({
      type: 'LaunchedSessionCrashed',
      v: 1,
      id: this.deps.ids.uuidv7() as EventId,
      at,
      hostEpoch: this.deps.hostEpoch,
      payload: { dwarfId, launchId }
    })
    return { owned: true, covered: false, crashed: true }
  }
}
