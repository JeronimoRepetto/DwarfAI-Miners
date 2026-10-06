// `CrewCommands.endAllIn` (05 §3.2; 16 §4.2; 07 S4.05, S4.07, S15.02, S15.15, S2.05, S2.15;
// ADR-014 items 1, 6): Remove mine ends every present dwarf of the mine, mid-turn included and
// whatever "Stop dwarf…" availability says (OQ-06), and reports which ended and which did not.
//
// - One transaction marks every present dwarf `stopInFlight` (16 §2.2); after it commits, each gets
//   `DwarfStopRequested{why: 'remove-mine'}` (16 §2.3). Its required handler, launching's
//   `markStoppedByPerson`, runs inside that publish; if it throws, that dwarf is not ended and
//   counts as failed, so no end ever runs without `stopped_by_person` (16 §2.3, AR-24).
// - The ends run in parallel, one `SessionTerminator.end(dwarfId, 'remove-mine')` per dwarf, never
//   `endAll`, which could not skip a dwarf whose handler failed. The command answers once every end
//   settled. An end that rejects is a failed end: the dwarf is kept (ADR-014 item 6 fails closed).
// - `ended`: the OS confirmed the exit, so the dwarf departs `mine-removed` through the single
//   departure path, `sessionClosed` (06 §5.1; S2.05: its open panels close). An exit route that
//   departed it first leaves that departure as is (one departure per dwarf, 09 §5.6).
// - `failed`: `stopInFlight` is cleared and the pending `why` forgotten (S2.15, S4.07); the dwarf
//   stays with its real status and `DwarfStopFailed{why: 'remove-mine'}` is published. No toast
//   names it: mines' one `MineRemovalFailed` is the only message (ADR-014 item 6; 08 §2.2). A failed
//   dwarf that departed meanwhile is gone after all (16 §2.5 re-read) and is reported ended.
import type { DwarfId, EventId, HostEpoch, MineId } from '../../../kernel/domain/values'
import type { Clock } from '../../../kernel/ports/clock'
import type { DomainEventBus } from '../../../kernel/ports/domainEventBus'
import type { IdGenerator } from '../../../kernel/ports/idGenerator'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import { applyPresence } from '../domain/dwarf'
import { isGone, type DepartureCause, type EndReason } from '../domain/presence'
import type { DwarfRepository } from '../ports/dwarfRepository'
import type { EndOutcome, SessionTerminator } from '../ports/sessionTerminator'
import type { CrewCommands } from './arrival'
import type { CrewEndEvent } from './events'

const WHY: EndReason = 'remove-mine'
/** `departureCause('remove-mine', …)` (06 §5.1): owned or observed, the same cause. */
const CAUSE: DepartureCause = 'mine-removed'
/** What a rejected end is taken as: not ended, so the dwarf is kept (ADR-014 item 6). */
const REJECTED: EndOutcome = { kind: 'failed', reason: 'protocol-error' }

/** 05 §3.2 `CrewCommands.endAllIn`, the member mines calls along its one edge (05 §1.3). */
export interface CrewEnds {
  endAllIn(mineId: MineId, requestId: string): Promise<{ ended: DwarfId[]; failed: DwarfId[] }> // why 'remove-mine'
}

export interface CrewEndsDeps {
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

export class CrewEndAllIn implements CrewEnds {
  constructor(private readonly deps: CrewEndsDeps) {}

  async endAllIn(
    mineId: MineId,
    requestId: string
  ): Promise<{ ended: DwarfId[]; failed: DwarfId[] }> {
    const { repository, transactions, terminator } = this.deps
    const crew = transactions.inTransaction(() => {
      const present = repository.inMine(mineId).filter((dwarf) => !isGone(dwarf))
      for (const dwarf of present) repository.save({ ...dwarf, stopInFlight: true })
      return present.map((dwarf) => dwarf.id)
    })
    // Every stop request first (launching marks each before any end runs), then the ends at once.
    const requested = crew.filter((dwarfId) => this.requestStop(dwarfId, requestId))
    const outcomes = await Promise.all(
      requested.map((dwarfId) => terminator.end(dwarfId, WHY).catch((): EndOutcome => REJECTED))
    )
    const endedNow = new Set(requested.filter((_, at) => outcomes[at]?.kind === 'ended'))
    const ended: DwarfId[] = []
    const failed: DwarfId[] = []
    for (const dwarfId of crew) {
      if (endedNow.has(dwarfId)) {
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
