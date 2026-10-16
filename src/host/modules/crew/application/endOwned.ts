// `CrewCommands.endOwned` (05 §3.2; 16 §4.2; 07 S4.05, S4.07, S15.02, S15.15, S2.15; ADR-014 items
// 1, 6, 9; 06 INV-120, INV-121): Stop everything and quit ends every owned session launching names,
// whatever "Stop dwarf…" availability says (S4.05), and reports which ended and which did not. It is
// launching's `stopAll` call along the launching → crew edge (05 §1.3; AR-13 applied).
//
// - One transaction marks every named dwarf still present `stopInFlight`, with its pending
//   `why = 'stop-all'` (Host memory, `PendingEndMemory`; 16 §2.2), so an exit route that runs first
//   departs it `stopped` (`departureCause`, 06 §5.1). After it commits, each gets
//   `DwarfStopRequested{why: 'stop-all'}` (16 §2.3): its required handler, launching's
//   `markStoppedByPerson`, runs inside that publish; if it throws, that dwarf is not ended and
//   counts as failed, so no end ever runs without `stopped_by_person` (16 §2.3, AR-24).
// - The ends run in parallel, one `SessionTerminator.end(dwarfId, 'stop-all')` per dwarf (ADR-014
//   item 1: identity-checked), and the command answers once every end settled. An end that rejects
//   is a failed end: the dwarf is kept (ADR-014 item 6 fails closed).
// - `ended`: the OS confirmed the exit, so the dwarf departs `stopped` through the single departure
//   path, `sessionClosed` (06 §5.1). An exit route that departed it first leaves that departure as
//   is (one departure per dwarf, 09 §5.6). A named dwarf that already left has no session left: it
//   is reported ended with nothing ended or published (16 §4.2 `SessionTerminator`).
// - `failed`: `stopInFlight` is cleared and the pending `why` forgotten (S2.15, S4.07); the dwarf
//   stays with its real status and `DwarfStopFailed{why: 'stop-all'}` is published. No toast names
//   it: launching's one `StopAllIncomplete` is the only message (ADR-014 item 9; 08 §2.2). A failed
//   dwarf that departed meanwhile is gone after all (16 §2.5 re-read) and is reported ended.
// - An id never stored is a programming error (`HostInvariantError`): launching names only dwarfs
//   its live records reference (09 §4.3 `dwarf_id REFERENCES dwarfs`).
import { HostInvariantError } from '../../../kernel/domain/errors'
import type { DwarfId, EventId, HostEpoch } from '../../../kernel/domain/values'
import type { Clock } from '../../../kernel/ports/clock'
import type { DomainEventBus } from '../../../kernel/ports/domainEventBus'
import type { IdGenerator } from '../../../kernel/ports/idGenerator'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import { applyPresence, recordPendingEnd } from '../domain/dwarf'
import { isGone, type DepartureCause, type EndReason } from '../domain/presence'
import type { DwarfRepository } from '../ports/dwarfRepository'
import type { EndOutcome, SessionTerminator } from '../ports/sessionTerminator'
import type { CrewCommands } from './arrival'
import type { CrewEndEvent } from './events'

const WHY: EndReason = 'stop-all'
/** `departureCause('stop-all', …)` (06 §5.1). */
const CAUSE: DepartureCause = 'stopped'
/** What a rejected end is taken as: not ended, so the dwarf is kept (ADR-014 item 6). */
const REJECTED: EndOutcome = { kind: 'failed', reason: 'protocol-error' }

/** 05 §3.2 `CrewCommands.endOwned`, the member launching's `stopAll` calls along its crew edge. */
export interface CrewOwnedEnds {
  endOwned(dwarfIds: DwarfId[], requestId: string): Promise<{ ended: DwarfId[]; failed: DwarfId[] }> // why 'stop-all'
}

export interface CrewEndOwnedDeps {
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
}

export class CrewEndOwned implements CrewOwnedEnds {
  constructor(private readonly deps: CrewEndOwnedDeps) {}

  async endOwned(
    dwarfIds: DwarfId[],
    requestId: string
  ): Promise<{ ended: DwarfId[]; failed: DwarfId[] }> {
    const { repository, transactions, terminator } = this.deps
    const present = transactions.inTransaction(() =>
      dwarfIds.filter((dwarfId) => {
        const dwarf = repository.byId(dwarfId)
        if (dwarf === null) throw new HostInvariantError(`no dwarf ${dwarfId} was ever stored`)
        if (isGone(dwarf)) return false
        repository.save({ ...recordPendingEnd(dwarf, WHY), stopInFlight: true })
        return true
      })
    )
    // Every stop request first (launching marks each before any end runs), then the ends at once.
    const requested = present.filter((dwarfId) => this.requestStop(dwarfId, requestId))
    const outcomes = await Promise.all(
      requested.map((dwarfId) => terminator.end(dwarfId, WHY).catch((): EndOutcome => REJECTED))
    )
    const endedNow = new Set(requested.filter((_, at) => outcomes[at]?.kind === 'ended'))
    const tried = new Set(present)
    const ended: DwarfId[] = []
    const failed: DwarfId[] = []
    for (const dwarfId of dwarfIds) {
      if (!tried.has(dwarfId)) ended.push(dwarfId)
      else if (endedNow.has(dwarfId)) {
        this.deps.departures.sessionClosed(dwarfId, CAUSE)
        ended.push(dwarfId)
      } else if (this.stopFailed(dwarfId, requestId)) failed.push(dwarfId)
      else ended.push(dwarfId)
    }
    return { ended, failed }
  }

  /** `DwarfStopRequested`; false when its required handler threw, so no end may run (16 §2.3). */
  private requestStop(dwarfId: DwarfId, requestId: string): boolean {
    try {
      this.publish('DwarfStopRequested', { dwarfId, requestId, why: WHY })
      return true
    } catch {
      return false
    }
  }

  /** S2.15, S4.07: the dwarf stays; false when it departed meanwhile (then it is not failed). */
  private stopFailed(dwarfId: DwarfId, requestId: string): boolean {
    const { repository, transactions } = this.deps
    const stays = transactions.inTransaction(() => {
      const dwarf = repository.byId(dwarfId)
      if (dwarf === null || isGone(dwarf)) return false
      const next = applyPresence(dwarf, { type: 'stop-failed' })
      repository.save({ ...(next.ok ? next.value : dwarf), stopInFlight: false })
      return true
    })
    if (stays) {
      this.publish('DwarfStopFailed', { dwarfId, requestId, why: WHY, reason: 'could-not-end' })
    }
    return stays
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
