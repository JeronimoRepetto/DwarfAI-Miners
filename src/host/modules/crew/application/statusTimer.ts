// Machine 1's clock (07 §1; ADR-032 item 3; 16 §4.2). The status is re-derived from a dwarf's
// committed facts whenever they change and once at its idle-to-asleep instant: one kernel
// `Scheduler` task per idle dwarf at `max(idleSince, lastActivityAt) + 60 s`, cancelled and
// rescheduled on every change. Nothing here is persisted: at boot the statuses are recomputed
// from the persisted facts (S1.18). No `setTimeout`/`setInterval`: time is the injected clock.
import type { DwarfId, EventId, HostEpoch } from '../../../kernel/domain/values'
import type { Clock } from '../../../kernel/ports/clock'
import type { DomainEventBus } from '../../../kernel/ports/domainEventBus'
import type { IdGenerator } from '../../../kernel/ports/idGenerator'
import type { Scheduler } from '../../../kernel/ports/scheduler'
import type { DwarfStatusChanged } from '../domain/events'
import { classifyDwarfStatus, type DwarfStatus, type StatusFacts } from '../domain/status'
import { nextWakeAt } from '../domain/statusFacts'

export interface StatusTimerDeps {
  readonly clock: Clock
  readonly scheduler: Scheduler
  readonly bus: Pick<DomainEventBus<DwarfStatusChanged>, 'publish'>
  readonly ids: IdGenerator
  readonly hostEpoch: HostEpoch
}

interface Tracked {
  facts: StatusFacts
  status: DwarfStatus
  wake: { cancel(): void } | null
}

export class StatusTimer {
  private readonly tracked = new Map<DwarfId, Tracked>()

  constructor(private readonly deps: StatusTimerDeps) {}

  /**
   * Boot (S1.18): every present dwarf's status from its persisted facts and the clock now, with
   * its wake-up scheduled again. Publishes nothing: the first snapshot carries these statuses.
   */
  recompute(present: Iterable<{ dwarfId: DwarfId; facts: StatusFacts }>): void {
    for (const { dwarfId, facts } of present) this.track(dwarfId, facts)
  }

  /**
   * The facts of a dwarf were committed (call after the transaction, 16 §2.3). The first call
   * for a dwarf is its arrival, whose status `DwarfArrived` carries, so it publishes nothing;
   * later calls publish `DwarfStatusChanged` only when the derived status changed.
   */
  factsChanged(dwarfId: DwarfId, facts: StatusFacts): void {
    const entry = this.tracked.get(dwarfId)
    if (entry === undefined) {
      this.track(dwarfId, facts)
      return
    }
    entry.facts = facts
    this.reevaluate(dwarfId, entry)
  }

  /** S1.20: the machine ends; the wake-up is cancelled and the dwarf has no status. */
  departed(dwarfId: DwarfId): void {
    this.tracked.get(dwarfId)?.wake?.cancel()
    this.tracked.delete(dwarfId)
  }

  statusOf(dwarfId: DwarfId): DwarfStatus | null {
    return this.tracked.get(dwarfId)?.status ?? null
  }

  private track(dwarfId: DwarfId, facts: StatusFacts): void {
    this.tracked.get(dwarfId)?.wake?.cancel()
    const entry: Tracked = {
      facts,
      status: classifyDwarfStatus(facts, this.deps.clock.now()),
      wake: null
    }
    this.tracked.set(dwarfId, entry)
    this.schedule(dwarfId, entry)
  }

  private reevaluate(dwarfId: DwarfId, entry: Tracked): void {
    const now = this.deps.clock.now()
    const status = classifyDwarfStatus(entry.facts, now)
    if (status !== entry.status) {
      const from = entry.status
      entry.status = status
      this.publish(dwarfId, from, status, entry.facts, now)
    }
    this.schedule(dwarfId, entry)
  }

  /**
   * One wake-up at most per dwarf. A wall clock that moved (FM-113) only moves the instant the
   * wake-up fires: on fire the status is re-derived, and a dwarf not yet due is rescheduled.
   */
  private schedule(dwarfId: DwarfId, entry: Tracked): void {
    entry.wake?.cancel()
    entry.wake = null
    const wakeAt = nextWakeAt(entry.facts)
    if (wakeAt === null) return
    const delay = wakeAt - this.deps.clock.now()
    if (delay <= 0) return
    entry.wake = this.deps.scheduler.after(delay, () => {
      entry.wake = null
      if (this.tracked.get(dwarfId) === entry) this.reevaluate(dwarfId, entry)
    })
  }

  private publish(
    dwarfId: DwarfId,
    from: DwarfStatus,
    to: DwarfStatus,
    facts: StatusFacts,
    at: number
  ): void {
    const askedAt = to === 'asking' ? facts.openAsk?.askedAt : undefined
    this.deps.bus.publish({
      type: 'DwarfStatusChanged',
      v: 1,
      id: this.deps.ids.uuidv7() as EventId,
      at,
      hostEpoch: this.deps.hostEpoch,
      payload: askedAt === undefined ? { dwarfId, from, to } : { dwarfId, from, to, askedAt }
    })
  }
}
