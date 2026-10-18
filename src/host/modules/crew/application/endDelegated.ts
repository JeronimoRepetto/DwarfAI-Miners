// `CrewCommands.endDelegated` (05 §3.2; 16 §4.2 row `endDelegated`; 07 S8.08, S15.02, S15.15;
// ADR-014 items 1, 10; AMENDMENT-2, SC-AR-02; PO #17; ISSUE-205): the route of
// `DelegationSucceeded` (05 §4). A worker is an owned session whose process stays alive and idle
// after its turn, so once its result reached its parent the Host ends it, and it walks out like any
// dwarf (US-DLG-004.AC03, US-OBS-005).
//
// - Precondition: the worker is present and delegated (INV-28); otherwise nothing is ended and the
//   call answers `ended` (a repeated route, a worker that already left).
// - One transaction sets `stopInFlight` and the pending `why = 'delegation-done'` (Host memory,
//   `PendingEndMemory`; 16 §2.2), so an exit route that runs first departs it `stopped`
//   (`departureCause`, 06 §5.1). After it commits, `DwarfStopRequested{why: 'delegation-done',
//   requestId: delegationId}` (16 §2.3): its required handler, launching's `markStoppedByPerson`,
//   commits `stopped_by_person` before the end, so the exit raises no PO #62 "stopped unexpectedly"
//   toast. If it throws, nothing is ended (16 §2.3, AR-24) and the end failed.
// - Then `SessionTerminator.end(workerId, 'delegation-done')` (ADR-014 item 1). `ended` → the
//   worker departs `stopped` through the single departure path (`sessionClosed`); an exit route
//   that departed it first leaves that departure as is.
// - Failed (or rejected, ADR-014 item 6 fails closed): `stopInFlight` is cleared and the pending
//   `why` forgotten; the worker stays present with its real status, `DwarfStopFailed{why:
//   'delegation-done'}` is published (no route turns it into a toast: only `stop-dwarf`'s has one),
//   and the failure is logged with its class only (no name, no id beyond the allowlist, ADR-026).
import type { DwarfId, EventId, HostEpoch } from '../../../kernel/domain/values'
import type { Clock } from '../../../kernel/ports/clock'
import type { DiagnosticsLog } from '../../../kernel/ports/diagnosticsLog'
import type { DomainEventBus } from '../../../kernel/ports/domainEventBus'
import type { IdGenerator } from '../../../kernel/ports/idGenerator'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import { applyPresence, recordPendingEnd } from '../domain/dwarf'
import { isGone, type DepartureCause, type EndReason } from '../domain/presence'
import type { DwarfRepository } from '../ports/dwarfRepository'
import type { EndOutcome, SessionTerminator } from '../ports/sessionTerminator'
import type { CrewCommands } from './arrival'
import type { CrewEndEvent } from './events'

const WHY: EndReason = 'delegation-done'
/** `departureCause('delegation-done', …)` (06 §5.1). */
const CAUSE: DepartureCause = 'stopped'
/** What a rejected end, or one that could not be requested, is taken as: not ended. */
const REJECTED: EndOutcome = { kind: 'failed', reason: 'protocol-error' }
const ENDED: EndOutcome = { kind: 'ended' }

/** 05 §3.2 `CrewCommands.endDelegated`, the member the `DelegationSucceeded` route calls. */
export interface CrewDelegatedEnds {
  endDelegated(workerId: DwarfId, delegationId: string): Promise<EndOutcome> // why 'delegation-done' (ADR-014 item 10; AMENDMENT-2, SC-AR-02): route of DelegationSucceeded; stopped_by_person first; walks out 'stopped'; no toast
}

export interface CrewEndDelegatedDeps {
  repository: DwarfRepository
  transactions: TransactionRunner
  bus: Pick<DomainEventBus<CrewEndEvent>, 'publish'>
  clock: Clock
  ids: IdGenerator
  hostEpoch: HostEpoch
  /** How the Host ends a session (ADR-014 item 1), bound by `host/wiring`. */
  terminator: SessionTerminator
  /** The single departure path (06 §5.1). */
  departures: Pick<CrewCommands, 'sessionClosed'>
  /** Where a failed end is recorded, allowlisted fields only (ADR-026). */
  log: DiagnosticsLog
}

export class CrewEndDelegated implements CrewDelegatedEnds {
  constructor(private readonly deps: CrewEndDelegatedDeps) {}

  async endDelegated(workerId: DwarfId, delegationId: string): Promise<EndOutcome> {
    if (!this.begin(workerId)) return { ...ENDED }
    if (!this.requestStop(workerId, delegationId))
      return this.failed(workerId, delegationId, REJECTED)
    const outcome = await this.deps.terminator
      .end(workerId, WHY)
      .catch((): EndOutcome => ({ ...REJECTED }))
    if (outcome.kind !== 'ended') return this.failed(workerId, delegationId, outcome)
    this.deps.departures.sessionClosed(workerId, CAUSE)
    return { ...ENDED }
  }

  /** The precondition, `stopInFlight` and the pending end, in one transaction (16 §2.2). */
  private begin(workerId: DwarfId): boolean {
    const { repository, transactions } = this.deps
    return transactions.inTransaction(() => {
      const worker = repository.byId(workerId)
      if (worker === null || isGone(worker) || !worker.delegated) return false
      repository.save({ ...recordPendingEnd(worker, WHY), stopInFlight: true })
      return true
    })
  }

  /** `DwarfStopRequested`; false when its required handler threw, so no end may run (16 §2.3). */
  private requestStop(workerId: DwarfId, delegationId: string): boolean {
    try {
      this.publish('DwarfStopRequested', { dwarfId: workerId, requestId: delegationId, why: WHY })
      return true
    } catch {
      return false
    }
  }

  /** The worker stays (S2.15, S15.15); ended after all when it departed meanwhile (16 §2.5). */
  private failed(workerId: DwarfId, delegationId: string, outcome: EndOutcome): EndOutcome {
    const { repository, transactions } = this.deps
    const stays = transactions.inTransaction(() => {
      const worker = repository.byId(workerId)
      if (worker === null || isGone(worker)) return false
      const next = applyPresence(worker, { type: 'stop-failed' })
      repository.save({ ...(next.ok ? next.value : worker), stopInFlight: false })
      return true
    })
    if (!stays) return { ...ENDED }
    this.publish('DwarfStopFailed', {
      dwarfId: workerId,
      requestId: delegationId,
      why: WHY,
      reason: 'could-not-end'
    })
    this.deps.log.record({
      level: 'warn',
      event: 'crew.delegated-end.failed',
      subsystem: 'crew',
      outcome: 'failed',
      causeClass: outcome.kind === 'failed' ? outcome.reason : 'unknown'
    })
    return { ...outcome }
  }

  private publish<K extends CrewEndEvent['type']>(
    type: K,
    payload: Extract<CrewEndEvent, { type: K }>['payload']
  ): void {
    const { bus, ids, clock, hostEpoch } = this.deps
    bus.publish({
      type,
      v: 1,
      id: ids.uuidv7() as EventId,
      at: clock.now(),
      hostEpoch,
      payload
    } as Extract<CrewEndEvent, { type: K }>)
  }
}
