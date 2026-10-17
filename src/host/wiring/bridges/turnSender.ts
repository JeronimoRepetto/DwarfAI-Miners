// The `TurnSender` bridge (16 §4.6 as extended by AMENDMENT-16, owner, 2026-10-15; 05 §4; 11 F4
// step 4; ISSUE-166): conversation → suppliers for a launched session. The dwarf's provider identity
// (crew) names its session; suppliers' `SessionChannels.sessionFor(ref)` is the only door to it, and
// `DriverSession.sendTurn` hands the turn over on stdin or the protocol, never argv (15 §1.2).
// `routedTurnSender` (ISSUE-167) sends every other dwarf that is observed to the observed-session
// relay (`ObservedSessionTurnSender`), over the targets `observedSendTargets` reads from crew and
// observation.
import type { DwarfId, ProviderIdentity } from '../../kernel/domain/values'
import type { TurnSender, TurnSendFailure, TurnSendResult } from '../../modules/conversation'
import type { ObservedSendTarget } from '../../modules/conversation/adapters/observed-send/ObservedSessionTurnSender'
import type { ObservationQueries, ObservedProcessIdentities } from '../../modules/observation'
import type { SessionChannels, TurnInput } from '../../modules/suppliers'

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
      return {
        providerId: dwarf.identity.providerId,
        providerSessionId: dwarf.identity.providerSessionId,
        process: deps.processes.processIdentityOf(dwarfId)
      }
    }
  }
}
