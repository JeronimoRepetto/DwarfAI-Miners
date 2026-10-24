// The `TurnSender` bridge (16 §4.6 as extended by AMENDMENT-16, owner, 2026-10-15; 05 §4; 11 F4
// step 4; ISSUE-166): conversation → suppliers for a launched session. The dwarf's provider identity
// (crew) names its session; suppliers' `SessionChannels.sessionFor(ref)` is the only door to it, and
// `DriverSession.sendTurn` hands the turn over on stdin or the protocol, never argv (15 §1.2).
// `routedTurnSender` (ISSUE-167) sends every other dwarf that is observed to the observed-session
// relay (`ObservedSessionTurnSender`), over the targets `observedSendTargets` reads from crew and
// observation. AMENDMENT-29: an observed Claude subagent's target carries its agent id and its LEAD
// session's process identity (`ObservedSubagentConsoles.leadProcessOf`), never a process of its own.
import type { DwarfId, ProviderIdentity } from '../../kernel/domain/values'
import type { TurnSender, TurnSendFailure, TurnSendResult } from '../../modules/conversation'
import type { ObservedSendTarget } from '../../modules/conversation/adapters/observed-send/ObservedSessionTurnSender'
import type {
  ObservationQueries,
  ObservedIdentities,
  ObservedProcessIdentities,
  ObservedSubagentConsoles
} from '../../modules/observation'
import type { ProviderDriver, SessionChannels, TurnInput } from '../../modules/suppliers'

export interface LaunchedTurnSenderDeps {
  /** The dwarf's provider identity (crew's `DwarfView.identity`), or null when it has none. */
  dwarfs: { identityOf(dwarfId: DwarfId): ProviderIdentity | null }
  sessions: Pick<SessionChannels, 'sessionFor'>
}

export function launchedTurnSender(deps: LaunchedTurnSenderDeps): TurnSender {
  return {
    send: async (dwarfId: DwarfId, turn: TurnInput): Promise<TurnSendResult> => {
      const identity = deps.dwarfs.identityOf(dwarfId)
      // FM-078, US-MSG-013.AC06: no live session (it ended, or its delivery route went away while
      // its process lives) is a closed session, never a silent drop.
      const session = identity === null ? null : deps.sessions.sessionFor(identity)
      if (session === null) return { ok: false, error: { kind: 'session-closed' } }
      try {
        const receipt = await session.sendTurn(turn)
        return {
          ok: true,
          value: {
            confidence: receipt.confidence,
            heldUntilTurnEnd: receipt.heldUntilTurnEnd,
            correlation: receipt.correlation,
            ...(receipt.providerTurnId === undefined
              ? {}
              : { providerTurnId: receipt.providerTurnId }),
            reactionEvidence: session.capabilities.reactionEvidence
          }
        }
      } catch (error) {
        return { ok: false, error: failureOf(error) }
      }
    }
  }
}

/** 15 §1.2: `sendTurn` rejects with a `DriverSendError`; anything else is a channel error. */
function failureOf(error: unknown): TurnSendFailure {
  if (typeof error === 'object' && error !== null && 'kind' in error) {
    const { kind, reason } = error as { kind: unknown; reason?: unknown }
    if (kind === 'session-closed') return { kind: 'session-closed' }
    if (kind === 'channel-error' && typeof reason === 'string') {
      return { kind: 'channel-error', reason }
    }
  }
  return { kind: 'channel-error', reason: 'the hand-over failed' }
}

export interface RoutedTurnSenderDeps {
  dwarfs: {
    /** The dwarf's provider identity (crew's `DwarfView.identity`), or null when it has none. */
    identityOf(dwarfId: DwarfId): ProviderIdentity | null
    /** Whether DwarfAI launched the dwarf's session (crew's `DwarfView.owned`). */
    owned(dwarfId: DwarfId): boolean
  }
  sessions: Pick<SessionChannels, 'sessionFor'>
  /** The observed-session relay (`ObservedSessionTurnSender`, ISSUE-167). */
  observed: TurnSender
}

/**
 * One `TurnSender` for every dwarf (16 §4.6 row `TurnSender`: "bridge → suppliers ... or
 * `ObservedSessionTurnSender`"; ISSUE-167): a dwarf with a live driver session is handed to its
 * driver; a dwarf that is not owned and has no driver session is observed, and goes to the observed
 * relay; an owned dwarf whose session is gone is `session-closed` and is never typed into a terminal
 * (its session was never the person's).
 */
export function routedTurnSender(deps: RoutedTurnSenderDeps): TurnSender {
  const launched = launchedTurnSender(deps)
  return {
    send: async (dwarfId: DwarfId, turn: TurnInput): Promise<TurnSendResult> => {
      const identity = deps.dwarfs.identityOf(dwarfId)
      if (identity === null) return { ok: false, error: { kind: 'session-closed' } }
      if (deps.sessions.sessionFor(identity) !== null) return launched.send(dwarfId, turn)
      if (deps.dwarfs.owned(dwarfId)) return { ok: false, error: { kind: 'session-closed' } }
      return deps.observed.send(dwarfId, turn)
    }
  }
}

export interface ObservedSendTargetsDeps {
  /** Crew's view of the dwarf (`CrewQueries.get`). */
  dwarfs: {
    get(dwarfId: DwarfId): { identity: ProviderIdentity; departed: boolean; owned: boolean } | null
  }
  /** Observation's read of the dwarfs it holds (`ObservationQueries`). */
  observation: Pick<ObservationQueries, 'observedSessionOf'>
  /** The process identity observation recorded for an observed dwarf (ADR-014 item 2). */
  processes: ObservedProcessIdentities
  /** AMENDMENT-29: a subagent's lead process; absent, a subagent has none (no send path). */
  subagents?: Pick<ObservedSubagentConsoles, 'leadProcessOf'>
}

/**
 * The `ObservedSessionTurnSender` targets over crew and observation: a present, not owned dwarf
 * that observation holds, with its provider identity and the process identity observation recorded
 * (null when it recorded none: the relay then has no send path). Anything else is no target.
 */
export function observedSendTargets(deps: ObservedSendTargetsDeps): {
  targetOf(dwarfId: DwarfId): ObservedSendTarget | null
} {
  return {
    targetOf: (dwarfId) => {
      const dwarf = deps.dwarfs.get(dwarfId)
      if (dwarf === null || dwarf.departed || dwarf.owned) return null
      if (deps.observation.observedSessionOf(dwarfId) === null) return null
      return targetOver(dwarfId, dwarf.identity, deps)
    }
  }
}

/**
 * The target of an observed dwarf of `identity`: a session with the process observation recorded,
 * or (AMENDMENT-29) a subagent with its agent id and its lead session's process.
 */
function targetOver(
  dwarfId: DwarfId,
  identity: ProviderIdentity,
  deps: {
    processes: ObservedProcessIdentities
    subagents?: Pick<ObservedSubagentConsoles, 'leadProcessOf'>
  }
): ObservedSendTarget {
  const base = {
    providerId: identity.providerId,
    providerSessionId: identity.providerSessionId
  }
  if (identity.providerAgentId === undefined) {
    return { ...base, process: deps.processes.processIdentityOf(dwarfId) }
  }
  return {
    ...base,
    providerAgentId: identity.providerAgentId,
    process: deps.subagents?.leadProcessOf(dwarfId) ?? null
  }
}

/**
 * The targets crew's `hasDeliveryRoute` reads (INV-33: `canReceiveMessages` needs a delivery route),
 * from observation alone: crew's own view calls this read, so it must not ask crew back. A dwarf
 * observation wrote to this Host run is a target with its provider identity and the process identity
 * observation recorded; any other (a launched dwarf, a dwarf not written to since the Host started)
 * has no observed route.
 */
export function observedRouteTargets(deps: {
  identities: ObservedIdentities
  processes: ObservedProcessIdentities
  /** AMENDMENT-29: a subagent's lead process; absent, a subagent has none (no send path). */
  subagents?: Pick<ObservedSubagentConsoles, 'leadProcessOf'>
}): { targetOf(dwarfId: DwarfId): ObservedSendTarget | null } {
  return {
    targetOf: (dwarfId) => {
      const identity = deps.identities.identityOf(dwarfId)
      return identity === null ? null : targetOver(dwarfId, identity, deps)
    }
  }
}

/**
 * The person's own CLI binary (ADR-009 D5: one resolver behind every driver's `detect()`; ADR-008
 * item 1: never one DwarfAI ships), from the first of `drivers` whose detection answers installed;
 * null when none does. The observed Codex queue runs it (ISSUE-167).
 */
export async function installedBinaryOf(
  drivers: readonly Pick<ProviderDriver, 'detect'>[]
): Promise<string | null> {
  for (const driver of drivers) {
    try {
      const detected = await driver.detect()
      if (detected.kind === 'installed') return detected.install.binaryPath
    } catch {
      // A detection that fails is no install; the next driver may answer.
    }
  }
  return null
}
