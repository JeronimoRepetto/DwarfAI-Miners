// `CrewCommands.stop` (05 §3.2; 16 §4.2 row `stop`; 07 S15.01, S15.13, S15.15, S15.18, S4.05–S4.07;
// ADR-014 items 1, 6; AMENDMENT-2, OQ-54; UC-019): "Stop dwarf…" ends the dwarf's whole session,
// also while a turn is open, never only the turn (kick stays retired, OQ-49).
//
// - Precondition: no stop in flight (06 INV-31 as amended; domain/stopAvailability.ts), else
//   `'already-stopping'` with nothing changed. An open turn, an open ask or an observed session is
//   not a refusal (US-MSG-016.AC01, AC04, AC06).
// - One transaction sets `stopInFlight` and the pending `why` (Host memory, `PendingEndMemory`;
//   16 §2.2). After it commits, `DwarfStopRequested{why: 'stop-dwarf'}` (16 §2.3): its required
//   handler, launching's `markStoppedByPerson`, runs inside that publish and commits
//   `stopped_by_person` before any end, so the exit never raises the PO #62 "stopped unexpectedly"
//   toast (FM-060; S4.05). If it throws, nothing is ended and the stop is a failed end,
//   `'could-not-end'` (16 §2.3, AR-24).
// - Then `SessionTerminator.end(dwarfId, 'stop-dwarf')` (ADR-014 item 1): identity-checked, owned
//   or observed alike; mid-turn the owned path is the driver's graceful close or interrupt, then the
//   tree kill (items 1, 3). An end that rejects is a failed end (item 6 fails closed).
// - `ended`: the OS confirmed the exit, so the dwarf departs `stopped` through the single departure
//   path, `sessionClosed` (06 §5.1; INV-26): never before the process closed, never on time alone
//   (US-MSG-008.AC05; BR-11). An exit route that departed it first leaves that departure as is.
// - Failed: `stopInFlight` is cleared and the pending `why` forgotten (S2.15, S15.15, S4.07); the
//   dwarf stays with its real status and `DwarfStopFailed{why: 'stop-dwarf'}` is published, whose
//   route is the one `toast {dwarf-stop-failed}` naming the dwarf (14 §2.4 B-F28; ADR-014 item 6;
//   wiring/routes/launching.ts). A dwarf that departed meanwhile is gone after all (16 §2.5
//   re-read): the stop answers ended.
// - A dwarf that already left its mine has no session left: ending an ended session is ended
//   (16 §4.2 `SessionTerminator`), with nothing published. An id never stored is a programming
//   error (`HostInvariantError`); the transport refuses it before crew runs.
import { HostInvariantError } from '../../../kernel/domain/errors'
import type {
  DwarfId,
  EventId,
  HostEpoch,
  MineId,
  ProviderIdentity,
  Result
} from '../../../kernel/domain/values'
import type { Clock } from '../../../kernel/ports/clock'
import type { DomainEventBus } from '../../../kernel/ports/domainEventBus'
import type { IdGenerator } from '../../../kernel/ports/idGenerator'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import { applyPresence, recordPendingEnd, type Dwarf } from '../domain/dwarf'
import { isGone, type DepartureCause, type EndReason } from '../domain/presence'
import { stopAvailability } from '../domain/stopAvailability'
import type { DwarfRepository } from '../ports/dwarfRepository'
import type { EndOutcome, SessionTerminator } from '../ports/sessionTerminator'
import type { CrewCommands } from './arrival'
import type { CrewEndEvent } from './events'
const WHY: EndReason = 'stop-dwarf'
/** `departureCause('stop-dwarf', …)` (06 §5.1): owned or observed, the same cause. */
const CAUSE: DepartureCause = 'stopped'
/** What a rejected end is taken as: not ended, so the dwarf is kept (ADR-014 item 6). */
const REJECTED: EndOutcome = { kind: 'failed', reason: 'protocol-error' }

/** 16 §4.2 `stop`'s answer. */
export type StopOutcome = Result<void, 'already-stopping' | 'could-not-end'>

/** 05 §3.2 `CrewCommands.stop`, the member B-M21 `crew.stop` calls (host/transport/methods/crewStop.ts). */
export interface CrewStops {
  /** requestId → `DwarfStopRequested` / `DwarfStopFailed` (08 §0). Answers once the end settled. */
  stop(dwarfId: DwarfId, requestId: string): Promise<StopOutcome>
}

export interface CrewStopDeps {
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

const ENDED: StopOutcome = { ok: true, value: undefined }

export class CrewStop implements CrewStops {
  constructor(private readonly deps: CrewStopDeps) {}

  async stop(dwarfId: DwarfId, requestId: string): Promise<StopOutcome> {
    const begun = this.begin(dwarfId)
    if (begun === 'gone') return { ...ENDED }
    if (begun === 'already-stopping') return { ok: false, error: 'already-stopping' }
    if (!this.requestStop(dwarfId, requestId)) return this.failed(dwarfId, requestId)
    const outcome = await this.deps.terminator
      .end(dwarfId, WHY)
      .catch((): EndOutcome => ({ ...REJECTED }))
    if (outcome.kind !== 'ended') return this.failed(dwarfId, requestId)
    this.deps.departures.sessionClosed(dwarfId, CAUSE)
    return { ...ENDED }
  }

  /** The precondition and `stopInFlight`, in one transaction (16 §2.2). */
  private begin(dwarfId: DwarfId): 'begun' | 'gone' | 'already-stopping' {
    const { repository, transactions } = this.deps
    return transactions.inTransaction(() => {
      const dwarf = repository.byId(dwarfId)
      if (dwarf === null) throw new HostInvariantError(`no dwarf ${dwarfId} was ever stored`)
      if (isGone(dwarf)) return 'gone'
      if (stopAvailability(dwarf) !== 'available') return 'already-stopping'
      repository.save({ ...recordPendingEnd(dwarf, WHY), stopInFlight: true })
      return 'begun'
    })
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

  /** S2.15, S15.15, S4.07: the dwarf stays, still running; ended when it departed meanwhile. */
  private failed(dwarfId: DwarfId, requestId: string): StopOutcome {
    const { repository, transactions } = this.deps
    const stays = transactions.inTransaction(() => {
      const dwarf = repository.byId(dwarfId)
      if (dwarf === null || isGone(dwarf)) return false
      const next = applyPresence(dwarf, { type: 'stop-failed' })
      repository.save({ ...(next.ok ? next.value : dwarf), stopInFlight: false })
      return true
    })
    if (!stays) return { ...ENDED }
    this.publish('DwarfStopFailed', { dwarfId, requestId, why: WHY, reason: 'could-not-end' })
    return { ok: false, error: 'could-not-end' }
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

/**
 * The `DwarfRepository` crew's commands and read model share, with each dwarf's pending end kept
 * in Host memory beside the stored rows (09 §4.2 has no column for `pendingEnd`; 05 §3.2, 16 §4.2):
 * set by the `save` of a dwarf whose end the Host asked for, cleared by one that forgot it (a failed
 * end, S2.15), and laid back on every read. So the exit routes read the `why` of the end the person
 * asked for and depart the dwarf for its cause (`departureCause`, 06 §5.1) whichever of the exit and
 * the terminator's answer comes first. A Host restart forgets it, as it forgets every end in flight;
 * `stopped_by_person` is what persists (16 §2.3).
 */
export class PendingEndMemory implements DwarfRepository {
  private readonly pending = new Map<DwarfId, EndReason>()

  constructor(private readonly stored: DwarfRepository) {}

  byId(id: DwarfId): Dwarf | null {
    return this.withPendingEnd(this.stored.byId(id))
  }

  byProviderIdentity(i: ProviderIdentity): Dwarf | null {
    return this.withPendingEnd(this.stored.byProviderIdentity(i))
  }

  inMine(id: MineId): Dwarf[] {
    return this.stored.inMine(id).map((d) => this.withPendingEnd(d) ?? d)
  }

  save(d: Dwarf): void {
    this.stored.save(d)
    if (d.pendingEnd === null) this.pending.delete(d.id)
    else this.pending.set(d.id, d.pendingEnd)
  }

  /** The `why` of the end the Host asked for and that has not failed, or null. */
  pendingEndOf(dwarfId: DwarfId): EndReason | null {
    return this.pending.get(dwarfId) ?? null
  }

  private withPendingEnd(d: Dwarf | null): Dwarf | null {
    const why = d === null ? undefined : this.pending.get(d.id)
    return d === null || why === undefined ? d : { ...d, pendingEnd: why }
  }
}
