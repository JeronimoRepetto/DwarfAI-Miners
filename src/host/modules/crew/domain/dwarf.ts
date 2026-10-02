// The `Dwarf` aggregate (06 §5.1), so far the parts machines 1 and 2 govern: arrival with its rank
// fixed, the pending end of each Host-requested end, the process state and presence, and the one
// departure. Pure: no I/O, no clock read (R1). No field records how the dwarf was created (INV-30).
import type { DwarfId, Instant, Result } from '../../../kernel/domain/values'
import {
  arrivedPresence,
  departureCause,
  nextPresence,
  type DepartureCause,
  type EndReason,
  type PresenceEvent,
  type PresenceRefusal,
  type PresenceState
} from './presence'
import type { DwarfRank } from './rank'
import type { StatusFacts } from './status'
import { arrivalFacts, departed } from './statusFacts'

export interface Dwarf extends PresenceState {
  readonly id: DwarfId
  /** Set for a subagent or a delegated worker (06 §5.1). */
  readonly parentDwarfId: DwarfId | null
  /** Fixed at creation by `rankForDepth` (INV-27). */
  readonly rank: DwarfRank
  /** The persisted inputs of the derived status (ADR-032 item 2). */
  facts: StatusFacts
  readonly arrivedAt: Instant
  /** The `why` of the end the Host asked for, kept until the exit arrives (05 §3.2, 16 §4.2). */
  pendingEnd: EndReason | null
}

/** `CrewCommands.arrive` (05 §3.2) minus the identity, which the repository binds (ISSUE-069). */
export interface DwarfArrival {
  id: DwarfId
  parentDwarfId: DwarfId | null
  rank: DwarfRank
  /** `'working'` with a pending first message or a turn in progress, else `'idle'` (S1.01, S1.02). */
  status: 'working' | 'idle'
  at: Instant
}

/** S2.01 with S1.01 / S1.02: present at once, process running, rank fixed for good. */
export function arriveDwarf(a: DwarfArrival): Dwarf {
  return {
    id: a.id,
    parentDwarfId: a.parentDwarfId,
    rank: a.rank,
    facts: arrivalFacts(a.at, a.status),
    arrivedAt: a.at,
    pendingEnd: null,
    ...arrivedPresence()
  }
}

/** The Host asked the dwarf's session to end (`SessionTerminator.end(dwarfId, why)`); the latest ask wins. */
export function recordPendingEnd(d: Dwarf, why: EndReason): Dwarf {
  return { ...d, pendingEnd: why }
}

/** The cause the exit route passes to `sessionClosed`, or null for no departure (05 §4). */
export function causeOnExit(d: Dwarf, owned: boolean): DepartureCause | null {
  return departureCause(d.pendingEnd, owned)
}

/**
 * One machine-2 transition on the aggregate. A closed process also ends machine 1 (S1.20), and a
 * failed end forgets its pending `why`, so a later exit is not read as that end (S2.15).
 */
export function applyPresence(d: Dwarf, e: PresenceEvent): Result<Dwarf, PresenceRefusal> {
  const next = nextPresence(d, e)
  if (!next.ok) return next
  const dwarf: Dwarf = { ...d, ...next.value }
  if (e.type === 'stop-failed') dwarf.pendingEnd = null
  if (dwarf.processState === 'closed') dwarf.facts = departed(dwarf.facts)
  return { ok: true, value: dwarf }
}
