// The subtask run: the `SubtaskDelegated` route that turns an accepted delegation into a visible
// worker (16 §4.8 rows `SubtaskRouter` and `WorkerLauncher`, §5.4, §6.4; 07 S8.03-S8.07, S8.12;
// ADR-013 items 4-5; ADR-028 D2; UC-017; 11 F6 steps 3-6). It runs off the tool call:
// `DelegationEndpoint.delegate` has already answered the ticket (later: ISSUE-209 composes the
// route).
//
// - `run(delegationId)`: only an `attempted` delegation is routed; any other (settled, running,
//   unknown) is left alone, so a repeated route does nothing twice. `SubtaskRouter.route(task,
//   context)` sends the stored task and context to Jev (`purpose: 'subtask'`): this is the only
//   path they take to TypeSafe, and the endpoint's gate already refused them with the setting off
//   (S8.02, C-26, INV-88). Then:
//   - `jev-unreachable` → S8.04; `jev-could-not-choose` (an `effort-ceiling` included, ADR-028
//     D2) → S8.05; a routing call that rejects reached no answer from Jev → S8.04 (retryable).
//   - a pick that names no supplier leaves nothing a Host driver can launch → S8.06 `no-provider`
//     (21 §2 cut 3: only the step's launchable providers are Jev's candidates).
//   - otherwise `WorkerLauncher.launchWorker(delegationId, parent, pick, task)` (AMENDMENT-15):
//     the ordinary launch pipeline with Jev's pick as given (INV-85). A worker → S8.03 with its id
//     and `DelegationWorkerLaunched`; any launch cause, or a launch that rejects → S8.07.
// - `failRoutingOnBoot()` (boot, before any route runs): every delegation still `attempted` was
//   being routed when the Host stopped, so no worker exists for it → S8.12 `worker-lost` (FM-021).
//   A `running` one is the INV-84 reconcile's (its worker may have survived; later: ISSUE-209).
//
// Each settlement re-reads the delegation inside its transaction and applies the 07 §8 event to
// what is stored now: a delegation that settled meanwhile (the parent departed, S8.11) refuses the
// event, and nothing is written, published or launched. Events are published after the commit
// (16 §2.3), then `settled(ticket)` wakes the `subtask_result` calls waiting on the ticket
// (`DelegationEndpointService.delegationSettled`). The task and context are never logged and never
// put in an event (16 §5.6, NFR-SEC-12); the log gets the failure's class only.
import type { DwarfId, EventId, HostEpoch } from '../../../kernel/domain/values'
import type { Clock } from '../../../kernel/ports/clock'
import type { DiagnosticsLog } from '../../../kernel/ports/diagnosticsLog'
import type { DomainEventBus } from '../../../kernel/ports/domainEventBus'
import type { IdGenerator } from '../../../kernel/ports/idGenerator'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import {
  applyEvent,
  type Delegation,
  type DelegationEvent,
  type DelegationId
} from '../domain/delegation'
import type { DelegationFailed, DelegationWorkerLaunched } from '../domain/events'
import type { DelegationTicketStore } from '../ports/delegationStores'
import type { JevSuggestionView, SubtaskRouter, WorkerLauncher } from '../ports/subtaskRouting'

/** Every event the subtask run publishes (08 §0). */
export type SubtaskRunEvent = DelegationWorkerLaunched | DelegationFailed

export interface SubtaskRunDeps {
  tickets: DelegationTicketStore
  /** The bridge → jev (`purpose: 'subtask'`). */
  router: SubtaskRouter
  /** The bridge → launching (a delegated launch, answered at its settlement). */
  launcher: WorkerLauncher
  transactions: TransactionRunner
  /** Publishes after each commit (16 §2.3). */
  bus: DomainEventBus<SubtaskRunEvent>
  clock: Clock
  ids: IdGenerator
  /** This boot's epoch. */
  hostEpoch: HostEpoch
  log: DiagnosticsLog
  /** Wakes the `result` calls waiting on a ticket whose delegation changed state. */
  settled?: (ticket: string) => void
}

type RouteOutcome =
  | { kind: 'pick'; pick: JevSuggestionView & { providerId: string } }
  | { kind: 'settle'; event: DelegationEvent }

export class SubtaskRunService {
  constructor(private readonly deps: SubtaskRunDeps) {}

  /** The `SubtaskDelegated` route: routes the subtask through Jev and launches its worker. */
  async run(delegationId: DelegationId): Promise<void> {
    const delegation = this.attempted(delegationId)
    if (delegation === null || delegation.task === undefined) return
    const routed = await this.route(delegation)
    if (routed.kind === 'settle') {
      this.apply(delegationId, routed.event)
      return
    }
    // Settled while Jev answered (S8.11): no worker for a delegation that is over.
    if (this.attempted(delegationId) === null) return
    this.apply(delegationId, await this.launch(delegation, routed.pick))
  }

  /** Boot: fails every delegation the stopped Host was routing (S8.12); returns how many. */
  failRoutingOnBoot(): number {
    const routing = this.deps.tickets.inFlight().filter((d) => d.state === 'attempted')
    let failed = 0
    for (const delegation of routing) {
      if (this.apply(delegation.id, { type: 'host-crashed-while-routing' })) failed += 1
    }
    return failed
  }

  private async route(delegation: Delegation): Promise<RouteOutcome> {
    let answer: Awaited<ReturnType<SubtaskRouter['route']>>
    try {
      answer =
        delegation.context === undefined
          ? await this.deps.router.route(delegation.task as string)
          : await this.deps.router.route(delegation.task as string, delegation.context)
    } catch {
      this.logFailure('route-rejected')
      return { kind: 'settle', event: { type: 'jev-unreachable' } }
    }
    if (!answer.ok) return { kind: 'settle', event: { type: answer.error } }
    const pick = answer.value
    if (pick.providerId === undefined || pick.fallback !== undefined) {
      return { kind: 'settle', event: { type: 'no-provider' } }
    }
    return { kind: 'pick', pick: pick as JevSuggestionView & { providerId: string } }
  }

  private async launch(delegation: Delegation, pick: JevSuggestionView): Promise<DelegationEvent> {
    try {
      const worker = await this.deps.launcher.launchWorker(
        delegation.id,
        delegation.parentDwarfId,
        pick,
        delegation.task as string
      )
      return worker.ok
        ? { type: 'worker-launched', workerDwarfId: worker.value }
        : { type: 'worker-launch-failed' }
    } catch {
      this.logFailure('launch-rejected')
      return { type: 'worker-launch-failed' }
    }
  }

  /** The stored delegation when it is still `attempted`, else `null`. */
  private attempted(delegationId: DelegationId): Delegation | null {
    return (
      this.deps.tickets.inFlight().find((d) => d.id === delegationId && d.state === 'attempted') ??
      null
    )
  }

  /** Applies `event` to the stored delegation, commits, then publishes and wakes. */
  private apply(delegationId: DelegationId, event: DelegationEvent): boolean {
    const { transactions, tickets, clock } = this.deps
    const applied = transactions.inTransaction(() => {
      const current = tickets.inFlight().find((d) => d.id === delegationId)
      if (current === undefined) return null
      const next = applyEvent(current, event, clock.now())
      if (!next.ok) return null
      tickets.save(next.value.delegation)
      return next.value.delegation
    })
    if (applied === null) return false
    this.publish(applied)
    this.deps.settled?.(applied.ticket)
    return true
  }

  private publish(delegation: Delegation): void {
    if (delegation.state === 'running' && delegation.workerDwarfId !== undefined) {
      this.deps.bus.publish(
        this.event('DelegationWorkerLaunched', {
          delegationId: delegation.id,
          workerDwarfId: delegation.workerDwarfId
        })
      )
      return
    }
    if (delegation.state === 'failed' && delegation.failure !== undefined) {
      this.deps.bus.publish(
        this.event('DelegationFailed', {
          delegationId: delegation.id,
          parentDwarfId: delegation.parentDwarfId as DwarfId,
          failure: delegation.failure
        })
      )
    }
  }

  private logFailure(causeClass: string): void {
    this.deps.log.record({
      level: 'warn',
      event: 'delegation.subtask.failed',
      subsystem: 'delegation',
      outcome: 'failed',
      causeClass
    })
  }

  private event<T extends SubtaskRunEvent['type']>(
    type: T,
    payload: Extract<SubtaskRunEvent, { type: T }>['payload']
  ): Extract<SubtaskRunEvent, { type: T }> {
    const { ids, clock, hostEpoch } = this.deps
    return {
      type,
      v: 1,
      id: ids.uuidv7() as EventId,
      at: clock.now(),
      hostEpoch,
      payload
    } as Extract<SubtaskRunEvent, { type: T }>
  }
}
