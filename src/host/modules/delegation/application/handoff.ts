// The invisible result handoff (16 §5.4 "Handoff (PO #19, INV-68)"; ADR-013 item 6; 07 S8.08;
// 11 F6 step 7; UC-017 main flow and "Turn-input handoff"; ISSUE-205).
//
// - `workerTurnEnded(end, lastText)`: the route of the worker's `TurnEnded` (later: ISSUE-209
//   composes it). Lead decision (2026-09-30): the delegation's outcome is the text of the worker's
//   last assistant message when its FIRST reliable turn end arrives (`reliability: 'reliable'`; an
//   inferred end is not a result), held in Host memory only until the handoff is delivered, never
//   stored and never logged (NFR-SEC-12). A worker with no running delegation, or one whose result
//   was already taken, changes nothing.
// - The handoff's route is the parent driver's (`viaOf`):
//   - `tool-result` (every v1 driver with an MCP entry): the result is the answer of the parent's
//     own `subtask_result` (or `delegate_subtask`) call, the one already waiting or the next one
//     (`DelegationEndpointService.result` asks `answer`). `answer` writes `handoff {via:
//     'tool-result', phase: 'sending'}` before the response exists, and the MCP adapter reports
//     the response's flush (`responseFlushed`): flushed to an open connection → `delivered`,
//     `succeeded` (S8.08) and `DelegationSucceeded{via, workerDwarfId}` after the commit; not
//     flushed → nothing more: the delegation stays `running` with the handoff `sending`, and the
//     parent's next `subtask_result` is answered again (the result never reached it).
//   - `turn-input` (a driver that needs the result pushed): `handoff {via: 'turn-input', phase:
//     'sending'}`, then ONE `ParentDeliverer.deliver(parent, marked text)` (the marker names the
//     delegation, 18 T-25); `delivered` → `succeeded` and `DelegationSucceeded`. A failed or
//     rejected push is never retried (ADR-013 O-13b: a second copy could reach the parent twice)
//     and is logged by class only; settling it (S8.13, the parent's line) is later: ISSUE-206.
// - No message row, frame, toast or badge exists for a handoff (PO #19, 14 §2.4): this file writes
//   only the delegation record. Events go out after the commit (16 §2.3), then `settled(ticket)`
//   wakes the `result` calls waiting on the ticket.
//
// Package gap (resolved in dev): 16 §5.4 names "a driver that needs the result pushed as turn
// input" but no capability says which. `viaOf(parent)` is that fact, bound by host/wiring from the
// parent's session (later: ISSUE-209); no v1 driver needs it (each relay entry answers tool calls).
import type { TurnEnded } from '../../../kernel/domain/sharedContracts'
import type { DwarfId, EventId, HostEpoch } from '../../../kernel/domain/values'
import type { Clock } from '../../../kernel/ports/clock'
import type { DiagnosticsLog } from '../../../kernel/ports/diagnosticsLog'
import type { DomainEventBus } from '../../../kernel/ports/domainEventBus'
import type { IdGenerator } from '../../../kernel/ports/idGenerator'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import { markHandoff } from '../../conversation'
import {
  applyEvent,
  beginHandoff,
  type Delegation,
  type DelegationHandoff,
  type DelegationId
} from '../domain/delegation'
import type { DelegationSucceeded } from '../domain/events'
import type { DelegationTicketStore } from '../ports/delegationStores'
import type {
  DelegationHandoffReport,
  ParentDeliverer,
  SubtaskOutcome,
  SubtaskResultView
} from '../ports/delegationServer'

/** Every event the handoff publishes (08 §0). */
export type HandoffEvent = DelegationSucceeded

export interface HandoffDeps {
  tickets: DelegationTicketStore
  /** The bridge → conversation `deliverInvisibly` (turn-input only, 16 §4.8). */
  deliverer: ParentDeliverer
  /** How the parent's driver takes a result (see the file header). */
  viaOf(parent: DwarfId): DelegationHandoff['via']
  transactions: TransactionRunner
  /** Publishes after each commit (16 §2.3). */
  bus: Pick<DomainEventBus<HandoffEvent>, 'publish'>
  clock: Clock
  ids: IdGenerator
  /** This boot's epoch. */
  hostEpoch: HostEpoch
  /** A failed push, by class only (ADR-026). */
  log: DiagnosticsLog
  /** Wakes the `result` calls waiting on a ticket whose delegation changed. */
  settled?: (ticket: string) => void
}

/** What `DelegationEndpointService.result` asks of a running delegation. */
export interface ToolResultHandoff {
  /** The `done` answer of a finished worker, its handoff written `sending` first; else null. */
  answer(delegation: Delegation): SubtaskResultView | null
}

interface Held {
  readonly ticket: string
  readonly outcome: SubtaskOutcome
}

export class ParentHandoffService implements DelegationHandoffReport, ToolResultHandoff {
  /** The finished results waiting for their tool-result handoff, in Host memory only. */
  private readonly held = new Map<DelegationId, Held>()
  /** The `done` answers handed out, until the adapter reports their flush. */
  private readonly answered = new WeakMap<SubtaskResultView, { id: DelegationId; ticket: string }>()

  constructor(private readonly deps: HandoffDeps) {}

  /** The route of the worker's `TurnEnded`, with its last assistant message's text. */
  async workerTurnEnded(end: TurnEnded, lastText: string | null): Promise<void> {
    if (end.reliability !== 'reliable') return
    const delegation = this.deps.tickets
      .inFlight()
      .find((d) => d.state === 'running' && d.workerDwarfId === end.dwarfId)
    if (delegation === undefined) return
    if (delegation.handoff !== undefined || this.held.has(delegation.id)) return
    const outcome: SubtaskOutcome =
      lastText === null ? { kind: end.kind } : { kind: end.kind, text: lastText }
    if (this.deps.viaOf(delegation.parentDwarfId) === 'turn-input') {
      await this.push(delegation, outcome)
      return
    }
    this.held.set(delegation.id, { ticket: delegation.ticket, outcome })
    this.deps.settled?.(delegation.ticket)
  }

  answer(delegation: Delegation): SubtaskResultView | null {
    const held = this.held.get(delegation.id)
    if (held === undefined) return null
    if (delegation.state !== 'running') {
      this.held.delete(delegation.id)
      return null
    }
    const begun = this.deps.transactions.inTransaction(() => {
      const current = this.deps.tickets.byTicket(held.ticket)
      if (current === null || current.state !== 'running') return false
      if (current.handoff !== undefined) {
        // Answered before and never flushed: the same result, still `sending`.
        return current.handoff.via === 'tool-result' && current.handoff.phase === 'sending'
      }
      const next = beginHandoff(current, 'tool-result', this.deps.clock.now())
      if (!next.ok) return false
      this.deps.tickets.save(next.value)
      return true
    })
    if (!begun) return null
    const view: SubtaskResultView = { status: 'done', outcome: { ...held.outcome } }
    this.answered.set(view, { id: delegation.id, ticket: held.ticket })
    return view
  }

  responseFlushed(answer: SubtaskResultView, flushed: boolean): void {
    const handed = this.answered.get(answer)
    if (handed === undefined) return
    this.answered.delete(answer)
    if (!flushed) return
    if (this.delivered(handed.ticket)) this.held.delete(handed.id)
  }

  /** The turn-input handoff: `sending`, one push, then `delivered`; never retried. */
  private async push(delegation: Delegation, outcome: SubtaskOutcome): Promise<void> {
    const begun = this.deps.transactions.inTransaction(() => {
      const current = this.deps.tickets.byTicket(delegation.ticket)
      if (current === null) return false
      const next = beginHandoff(current, 'turn-input', this.deps.clock.now())
      if (!next.ok) return false
      this.deps.tickets.save(next.value)
      return true
    })
    if (!begun) return
    const text = markHandoff(delegation.id, outcome.text ?? '')
    let pushed: Awaited<ReturnType<ParentDeliverer['deliver']>>
    try {
      pushed = await this.deps.deliverer.deliver(delegation.parentDwarfId, text)
    } catch {
      this.logFailure('rejected')
      return
    }
    if (!pushed.ok) {
      this.logFailure(pushed.error)
      return
    }
    this.delivered(delegation.ticket)
  }

  /** S8.08: `delivered`, `succeeded`, then `DelegationSucceeded` and the wake-up. */
  private delivered(ticket: string): boolean {
    const { transactions, tickets, clock } = this.deps
    const succeeded = transactions.inTransaction(() => {
      const current = tickets.byTicket(ticket)
      if (current === null) return null
      const next = applyEvent(current, { type: 'handoff-delivered' }, clock.now())
      if (!next.ok) return null
      tickets.save(next.value.delegation)
      return next.value.delegation
    })
    if (succeeded === null) return false
    const { handoff, workerDwarfId } = succeeded
    this.deps.bus.publish({
      type: 'DelegationSucceeded',
      v: 1,
      id: this.deps.ids.uuidv7() as EventId,
      at: clock.now(),
      hostEpoch: this.deps.hostEpoch,
      payload: {
        delegationId: succeeded.id,
        parentDwarfId: succeeded.parentDwarfId,
        workerDwarfId: workerDwarfId as DwarfId,
        via: (handoff as DelegationHandoff).via
      }
    })
    this.deps.settled?.(ticket)
    return true
  }

  private logFailure(causeClass: string): void {
    this.deps.log.record({
      level: 'warn',
      event: 'delegation.handoff.failed',
      subsystem: 'delegation',
      outcome: 'failed',
      causeClass
    })
  }
}
