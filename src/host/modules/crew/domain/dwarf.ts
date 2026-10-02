// The `Dwarf` aggregate (06 §5.1), so far the parts machines 1 and 2 govern: arrival with its rank
// fixed, the pending end of each Host-requested end, the process state and presence, and the one
// departure. Pure: no I/O, no clock read (R1). No field records how the dwarf was created (INV-30).
import type {
  DwarfId,
  Instant,
  MineId,
  ProviderId,
  ProviderIdentity,
  Result
} from '../../../kernel/domain/values'
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

/** 06 §5.1 `UsagePath`: `driver` for a dwarf DwarfAI launched, else `transcript`; set once (INV-92). */
export type UsagePath = 'driver' | 'transcript'

/** 06 §5.1 `SessionProfile`: strings from the supplier's own lists, as launched or observed. */
export interface SessionProfile {
  providerId: ProviderId
  model?: string
  effort?: string
  permissionMode?: string
}

export interface Dwarf extends PresenceState {
  readonly id: DwarfId
  /** Fixed at arrival. */
  readonly mineId: MineId
  /** The provider's own ids, UNIQUE across dwarfs (INV-21); changed only by a Host-driven resume (INV-22). */
  identity: ProviderIdentity
  /** Set only by a Host-driven resume that minted a new session id (ADR-015 item 7). */
  previousProviderSessionId: string | null
  /** Agent-facing, never overridden; the only name provider-bound text uses (NFR-PRIV-03). */
  readonly baseName: string
  /** Display only; never sent to a provider, never logged (INV-29). */
  customName: string | null
  /** True iff created as a delegation worker (INV-28). */
  readonly delegated: boolean
  sessionProfile: SessionProfile
  /** A stop for this dwarf is running (US-MSG-016). */
  stopInFlight: boolean
  /** Written once at binding, never changed (INV-92). */
  readonly usagePath: UsagePath
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

/** `CrewCommands.arrive` (05 §3.2) with the id and the names the arrival gives the dwarf. */
export interface DwarfArrival {
  id: DwarfId
  mineId: MineId
  identity: ProviderIdentity
  baseName: string
  delegated: boolean
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
    mineId: a.mineId,
    identity: a.identity,
    previousProviderSessionId: null,
    baseName: a.baseName,
    customName: null,
    delegated: a.delegated,
    sessionProfile: { providerId: a.identity.providerId },
    stopInFlight: false,
    // `driver` comes with the launch binding (EPIC-09); an arrival through `arrive` is observed.
    usagePath: 'transcript',
    parentDwarfId: a.parentDwarfId,
    rank: a.rank,
    facts: arrivalFacts(a.at, a.status),
    arrivedAt: a.at,
    pendingEnd: null,
    ...arrivedPresence()
  }
}

/**
 * INV-22: a Host-driven resume binds the dwarf to the provider's new identity. The id, the names,
 * the rank and the history stay; the session id it leaves is kept as `previousProviderSessionId`
 * when the resume minted a new one (ADR-015 item 7).
 */
export function rebindDwarf(d: Dwarf, next: ProviderIdentity): Dwarf {
  const newSession = next.providerSessionId !== d.identity.providerSessionId
  return {
    ...d,
    identity: next,
    previousProviderSessionId: newSession
      ? d.identity.providerSessionId
      : d.previousProviderSessionId
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
