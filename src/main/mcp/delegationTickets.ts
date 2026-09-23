import { randomUUID } from 'node:crypto'
import type { TurnOutcome } from '../domain/types'
import type { DelegationRouting, ResultBody } from './delegationProtocol'

/**
 * How long a SETTLED ticket's own result stays fetchable after it completes
 * (#511) — long enough for a slow `subtask_result` poll to still catch it
 * (the feature document's own example: Claude Code stdio has no per-request
 * timer, so a caller could reasonably check back minutes later), short
 * enough that a session's whole history of delegations never grows this
 * registry without bound.
 */
export const DEFAULT_TICKET_RETENTION_MS = 30 * 60 * 1000
/** Hard ceiling on retained tickets regardless of age, so a sweep that has not run yet still cannot grow this registry without bound. */
export const DEFAULT_MAX_RETAINED_TICKETS = 200

interface TicketRecord {
  /** Ownership: `get` treats a ticket presented with any other token exactly like one that does not exist (#511) — never a hint that a ticket by that name exists for someone else. */
  token: string
  state: ResultBody
  completedAt?: number
}

export interface DelegationTicketRegistryOptions {
  now?: () => number
  generateTicketId?: () => string
  retentionMs?: number
  maxRetained?: number
}

function defaultGenerateTicketId(): string {
  return randomUUID()
}

/**
 * One delegated subtask's own ticket, from acceptance through its eventual
 * `done`/`failed` conclusion (#511). Pure in-memory bookkeeping — no I/O, no
 * timer of its own; the delegation service calls `sweep()` on every request
 * it handles (`DelegationService.handle`), never on a schedule of its own.
 */
export class DelegationTicketRegistry {
  private readonly now: () => number
  private readonly generateTicketId: () => string
  private readonly retentionMs: number
  private readonly maxRetained: number
  private readonly tickets = new Map<string, TicketRecord>()

  constructor(options: DelegationTicketRegistryOptions = {}) {
    this.now = options.now ?? Date.now
    this.generateTicketId = options.generateTicketId ?? defaultGenerateTicketId
    this.retentionMs = options.retentionMs ?? DEFAULT_TICKET_RETENTION_MS
    this.maxRetained = options.maxRetained ?? DEFAULT_MAX_RETAINED_TICKETS
  }

  /** Mints a fresh, pending ticket for one accepted delegation. */
  create(token: string, routing: DelegationRouting): string {
    const id = this.generateTicketId()
    this.tickets.set(id, { token, state: { status: 'pending', routing } })
    this.enforceCap()
    return id
  }

  /** Settles a ticket with the delegated child's own real `TurnOutcome`. A ticket this registry never issued is a no-op. */
  resolveDone(ticketId: string, outcome: TurnOutcome): void {
    this.settle(ticketId, { status: 'done', outcome })
  }

  private settle(ticketId: string, state: ResultBody): void {
    const record = this.tickets.get(ticketId)
    if (record === undefined) return
    record.state = state
    record.completedAt = this.now()
  }

  /**
   * A ticket's current state, scoped to the token that created it. `undefined`
   * for a ticket this registry never issued, one it has since swept away, OR
   * one presented with a token other than its own owner's (#511) — the three
   * read identically, so a guessed ticket id never confirms that SOME
   * session, just not this one, has a live delegation running.
   */
  get(ticketId: string, token: string): ResultBody | undefined {
    const record = this.tickets.get(ticketId)
    if (record === undefined || record.token !== token) return undefined
    return record.state
  }

  /** Drops every settled ticket older than `retentionMs` (#511). Never drops a still-pending ticket, however old — that would turn a slow, legitimate turn into a fabricated `unknown-ticket`. */
  sweep(): void {
    const cutoff = this.now() - this.retentionMs
    for (const [id, record] of this.tickets) {
      if (record.completedAt !== undefined && record.completedAt < cutoff) this.tickets.delete(id)
    }
  }

  /**
   * Evicts the oldest SETTLED ticket once the registry is over its cap —
   * never a still-pending one (#511 LOW-8): a pending ticket disappearing
   * here would fabricate the exact `unknown-ticket` failure `sweep`'s own
   * comment above already refuses to produce for a slow, legitimate turn.
   * Map iteration order is insertion order, so the first settled entry found
   * is simply the oldest one — the same eviction idiom `heldCrew.ts`'s own
   * `sealConclusion` (#510) already holds for a bounded conclusion cache,
   * narrowed here to settled entries only.
   *
   * If EVERY retained ticket happens to be pending, this is a harmless
   * no-op that lets the registry grow past `maxRetained` until one of them
   * settles, rather than lying about one that is still running. With this
   * app's own shipped limits that branch is not reachable at all: the
   * concurrency gate in front of `create` (`DelegationConcurrencyGate`,
   * `DEFAULT_MAX_DELEGATIONS_GLOBAL`) holds at most that many tickets
   * pending at once, and it is wired far below `DEFAULT_MAX_RETAINED_TICKETS`
   * — see `delegationTickets.test.ts`'s own test pinning that relationship,
   * and `delegationConcurrency.ts` for the gate itself.
   */
  private enforceCap(): void {
    if (this.tickets.size <= this.maxRetained) return
    for (const [id, record] of this.tickets) {
      if (record.completedAt !== undefined) {
        this.tickets.delete(id)
        return
      }
    }
  }
}
