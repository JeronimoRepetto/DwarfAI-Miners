// The `DelegationEndpoint` driving port (16 §4.8, §5.4, §5.5; ADR-013 items 1, 3–4; 07 S8.01,
// S8.02; owner amendment N (AMENDMENT-14, OQ-85), 2026-10-15, §5.2 item 5), called by the MCP
// adapter with the token the MCP endpoint bound to the relay connection.
//
// - `delegate(token, subtask)`: the launch's token row is read again on every call (16 §5.2
//   item 5): its parent is the delegation's parent. A row with no parent yet (the relay
//   authenticated before the launch's dwarf arrived) makes the call wait until the launch
//   settles: `parentBound` releases it, `launchClosed` (the launch was revoked) rejects it, as
//   its relay connection is closed with it. Then, in one transaction (06 `admitDelegation`): a
//   delegated worker's launch is `depth-exceeded` (INV-81); the gate is re-checked against the
//   CURRENT "Subagent delegation" setting and the launch row (INV-80): closed → a delegation
//   created `failed{gate-closed}` (S8.02), `DelegationFailed` published and `gate-closed`
//   returned, so nothing is routed and nothing reaches Jev (ADR-013 item 4); the per-parent and
//   global caps → `concurrency-limit` with no row; otherwise the `attempted` row with its task and
//   context (S8.01), `SubtaskDelegated` published and the ticket returned at once. Routing and
//   launching the worker are the `SubtaskDelegated` route's (later: ISSUE-204).
// - `result(token, ticket, { maxMs })`: the ticket's state for this relay's parent only (a
//   ticket of another parent, or none, is `unknown-ticket`). In flight (`attempted`/`running`) it
//   waits on a `Scheduler` task up to `maxMs`, woken by `delegationSettled(ticket)`; nothing
//   settled → `pending` with the ticket. `failed` → its tool failure (16 §5.4 mapping); a
//   failure with no tool result (`handoff-failed`, `parent-gone`) or an already delivered
//   success has no result left for this relay: `unknown-ticket`. Handing a finished result over
//   (`done`, the `tool-result` handoff) is the handoff issue's (later: ISSUE-205).
// - Calls are serialized on the Host event loop (16 §5.5); a closed relay cancels nothing.
// - The subtask text is stored only on the `attempted` row (09 §4.6) and never logged or put in
//   an event (16 §5.6, NFR-SEC-12).
//
// `answerDelegateSubtask` / `answerSubtaskResult` are the two tools over this port, as the MCP
// adapter runs them (16 §5.5: `delegate`, then `result` with `DELEGATION_WAIT_MS`).
//
// Package gap (resolved in dev): `SubtaskDelegated` (08 §0 `{ delegationId; parentDwarfId }`) is
// declared here; the module's other events are in domain/events.ts.
import type { DomainEvent } from '../../../kernel/domain/domainEvent'
import type { DwarfId, EventId, HostEpoch, LaunchId, Result } from '../../../kernel/domain/values'
import type { Clock } from '../../../kernel/ports/clock'
import type { DiagnosticsLog } from '../../../kernel/ports/diagnosticsLog'
import type { DomainEventBus } from '../../../kernel/ports/domainEventBus'
import type { IdGenerator } from '../../../kernel/ports/idGenerator'
import type { Scheduler } from '../../../kernel/ports/scheduler'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import type { PreferencesQueries } from '../../preferences'
import { admitDelegation, type Delegation, type DelegationId } from '../domain/delegation'
import type { DelegationFailed } from '../domain/events'
import type { DelegationLimitRefusal } from '../domain/limits'
import { parseSubtask, type SubtaskTextRefusal } from '../domain/subtaskText'
import { NATIVE_SUBAGENT_FALLBACK_SENTENCE, toolFailure } from '../domain/toolFailure'
import type {
  DelegationTicketStore,
  DelegationToken,
  DelegationTokenStore
} from '../ports/delegationStores'
import type {
  DelegationEndpoint,
  DelegationLaunchFacts,
  SubtaskResultView,
  SubtaskToolFailure
} from '../ports/delegationServer'

/** 08 §0 `SubtaskDelegated` (S8.01; ADR-013). */
export type SubtaskDelegated = DomainEvent<
  'SubtaskDelegated',
  { delegationId: DelegationId; parentDwarfId: DwarfId }
>

/** Every event the endpoint publishes. */
export type DelegationEndpointEvent = SubtaskDelegated | DelegationFailed

export interface DelegationEndpointDeps {
  /** The token rows; `byLaunch` never returns a revoked row. */
  tokens: Pick<DelegationTokenStore, 'byLaunch'>
  tickets: DelegationTicketStore
  /** The launch row's gate facts, re-read on every call. */
  launches: DelegationLaunchFacts
  /** The Host preference "Subagent delegation" (06 §14.2), re-read on every call (S8.02). */
  preferences: Pick<PreferencesQueries, 'get'>
  transactions: TransactionRunner
  /** Publishes after each commit (16 §2.3). */
  bus: DomainEventBus<DelegationEndpointEvent>
  clock: Clock
  ids: IdGenerator
  /** This boot's epoch. */
  hostEpoch: HostEpoch
  /** The `result` wait (16 §5.5). */
  scheduler: Scheduler
}

/** The launch of a relay was revoked while a call waited for its parent. */
export class DelegationLaunchClosedError extends Error {
  constructor() {
    super('the delegating launch was revoked')
    this.name = 'DelegationLaunchClosedError'
  }
}

interface BindWaiter {
  resolve(): void
  reject(error: Error): void
}

type Refusal = 'gate-closed' | DelegationLimitRefusal

export class DelegationEndpointService implements DelegationEndpoint {
  private readonly bindWaiters = new Map<LaunchId, Set<BindWaiter>>()
  private readonly settleWaiters = new Map<string, Set<() => void>>()

  constructor(private readonly deps: DelegationEndpointDeps) {}

  async delegate(
    token: DelegationToken,
    subtask: { task: string; context?: string }
  ): Promise<Result<{ ticket: string }, Refusal>> {
    const parsed = parseSubtask(subtask)
    // The MCP input schema holds the same bounds; reaching here out of bounds is a caller defect.
    if (!parsed.ok) throw new RangeError(`delegate_subtask input refused: ${parsed.error}`)
    const parent = await this.parentOf(token.launchId)
    const { transactions, tickets, clock, ids, preferences, launches } = this.deps
    const admitted = transactions.inTransaction(() => {
      const inFlight = tickets.inFlight()
      const decision = admitDelegation(
        {
          id: ids.uuidv7() as DelegationId,
          ticket: ids.uuidv7(),
          parentDwarfId: parent,
          subtask: parsed.value,
          // Re-read now, never the value at issue (S8.02, INV-80).
          preferences: { subagentDelegationOn: preferences.get().subagentDelegationOn },
          // An unknown launch opens nothing (INV-80).
          launch: launches.gateOf(token.launchId) ?? {
            launchedWithLetJevChoose: false,
            delegated: false
          },
          inFlight: {
            parent: inFlight.filter((d) => d.parentDwarfId === parent).length,
            global: inFlight.length
          }
        },
        clock.now()
      )
      if (decision.ok) tickets.put(decision.value.delegation)
      return decision
    })
    if (!admitted.ok) return admitted
    const { delegation, transition } = admitted.value
    if (transition === 'S8.02') {
      this.deps.bus.publish(
        this.event('DelegationFailed', {
          delegationId: delegation.id,
          parentDwarfId: parent,
          failure: 'gate-closed'
        })
      )
      return { ok: false, error: 'gate-closed' }
    }
    this.deps.bus.publish(
      this.event('SubtaskDelegated', { delegationId: delegation.id, parentDwarfId: parent })
    )
    return { ok: true, value: { ticket: delegation.ticket } }
  }

  async result(
    token: DelegationToken,
    ticket: string,
    wait: { maxMs: number }
  ): Promise<SubtaskResultView> {
    const parent = await this.parentOf(token.launchId)
    // One deadline for the whole wait: a change that does not settle (attempted → running) wakes
    // the read but never restarts the wait (16 §5.5).
    const deadline = this.deps.clock.now() + Math.max(0, wait.maxMs)
    let current = this.read(ticket, parent)
    while (current !== null && isInFlight(current)) {
      const remaining = deadline - this.deps.clock.now()
      if (remaining <= 0) break
      await new Promise<void>((resolve) => {
        const waiters = this.waitersOf(ticket)
        const wake = (): void => {
          task.cancel()
          waiters.delete(wake)
          if (waiters.size === 0) this.settleWaiters.delete(ticket)
          resolve()
        }
        const task = this.deps.scheduler.after(remaining, wake)
        waiters.add(wake)
      })
      current = this.read(ticket, parent)
    }
    return viewOf(current, ticket)
  }

  /** The route of `DwarfLaunched`, after `DelegationLifecycle.bindParent`: releases waiting calls. */
  parentBound(launchId: LaunchId): void {
    for (const waiter of this.takeBindWaiters(launchId)) waiter.resolve()
  }

  /** The launch's token was revoked (`revokeLaunch`, `revokeFor`): calls waiting for it end. */
  launchClosed(launchId: LaunchId): void {
    for (const waiter of this.takeBindWaiters(launchId)) {
      waiter.reject(new DelegationLaunchClosedError())
    }
  }

  /** A delegation changed state (its routing, launch or handoff routes): waiting reads re-read. */
  delegationSettled(ticket: string): void {
    for (const wake of [...(this.settleWaiters.get(ticket) ?? [])]) wake()
  }

  /** The launch's current parent; waits for the bind while it has none (16 §5.2 item 5). */
  private async parentOf(launchId: LaunchId): Promise<DwarfId> {
    for (;;) {
      const row = this.deps.tokens.byLaunch(launchId)
      if (row === null) throw new DelegationLaunchClosedError()
      if (row.parentDwarfId !== null) return row.parentDwarfId
      await new Promise<void>((resolve, reject) => {
        let set = this.bindWaiters.get(launchId)
        if (set === undefined) {
          set = new Set()
          this.bindWaiters.set(launchId, set)
        }
        set.add({ resolve, reject })
      })
    }
  }

  private takeBindWaiters(launchId: LaunchId): BindWaiter[] {
    const waiters = [...(this.bindWaiters.get(launchId) ?? [])]
    this.bindWaiters.delete(launchId)
    return waiters
  }

  private waitersOf(ticket: string): Set<() => void> {
    let set = this.settleWaiters.get(ticket)
    if (set === undefined) {
      set = new Set()
      this.settleWaiters.set(ticket, set)
    }
    return set
  }

  /** The ticket's delegation when it belongs to `parent`, else `null`. */
  private read(ticket: string, parent: DwarfId): Delegation | null {
    const delegation = this.deps.tickets.byTicket(ticket)
    return delegation !== null && delegation.parentDwarfId === parent ? delegation : null
  }

  private event<T extends DelegationEndpointEvent['type']>(
    type: T,
    payload: Extract<DelegationEndpointEvent, { type: T }>['payload']
  ): Extract<DelegationEndpointEvent, { type: T }> {
    const { ids, clock, hostEpoch } = this.deps
    return {
      type,
      v: 1,
      id: ids.uuidv7() as EventId,
      at: clock.now(),
      hostEpoch,
      payload
    } as Extract<DelegationEndpointEvent, { type: T }>
  }
}

/**
 * `delegate_subtask` (16 §5.4, §5.5): the input is checked against 06 `SubtaskText` (characters
 * are code points, as 09 §4.6 counts them), then `delegate`, then `result` with the blocking
 * wait. Every outcome is a tool result: a refused input names its refusal, and anything the Host
 * could not complete is `unavailable` with the fallback sentence alone; no error message reaches
 * the result, and the log gets only its class (NFR-SEC-12).
 */
export async function answerDelegateSubtask(
  endpoint: DelegationEndpoint,
  token: DelegationToken,
  subtask: { task: string; context?: string },
  maxMs: number,
  log: DiagnosticsLog
): Promise<SubtaskResultView> {
  const parsed = parseSubtask(subtask)
  if (!parsed.ok) return { status: 'failed', failure: fallback(parsed.error) }
  try {
    const delegated = await endpoint.delegate(token, subtask)
    if (!delegated.ok) return failedView(delegated.error)
    return await endpoint.result(token, delegated.value.ticket, { maxMs })
  } catch (error) {
    return unavailable(error, log)
  }
}

/** `subtask_result` (16 §5.4): the ticket's state, waiting up to `maxMs` while it is in flight. */
export async function answerSubtaskResult(
  endpoint: DelegationEndpoint,
  token: DelegationToken,
  ticket: string,
  maxMs: number,
  log: DiagnosticsLog
): Promise<SubtaskResultView> {
  try {
    return await endpoint.result(token, ticket, { maxMs })
  } catch (error) {
    return unavailable(error, log)
  }
}

/** A failure with no reason text of its own: the detail is the fallback sentence alone. */
function fallback(kind: SubtaskTextRefusal | 'unavailable'): SubtaskToolFailure {
  return { kind, detail: NATIVE_SUBAGENT_FALLBACK_SENTENCE }
}

/** Logs the error's class only, never its message (ADR-026, NFR-SEC-12). */
function unavailable(error: unknown, log: DiagnosticsLog): SubtaskResultView {
  const code = (error as { code?: unknown } | null)?.code
  log.record({
    level: 'warn',
    event: 'delegation.tool.failed',
    subsystem: 'delegation',
    outcome: 'failed',
    causeClass:
      error instanceof DelegationLaunchClosedError
        ? 'launch-closed'
        : typeof code === 'string' && /^E[A-Z]+$/.test(code)
          ? code
          : 'unknown'
  })
  return { status: 'failed', failure: fallback('unavailable') }
}

function isInFlight(delegation: Delegation): boolean {
  return delegation.state === 'attempted' || delegation.state === 'running'
}

/** A delegation (or none) as this relay sees it (16 §5.4). */
function viewOf(delegation: Delegation | null, ticket: string): SubtaskResultView {
  if (delegation !== null && isInFlight(delegation)) return { status: 'pending', ticket }
  const failure =
    delegation?.state === 'failed' && delegation.failure !== undefined
      ? toolFailure(delegation.failure)
      : null
  return failure === null ? failedView('unknown-ticket') : { status: 'failed', failure }
}

function failedView(source: Refusal | 'unknown-ticket'): SubtaskResultView {
  const failure = toolFailure(source)
  if (failure === null) throw new Error(`no tool failure for ${source}`)
  return { status: 'failed', failure }
}
