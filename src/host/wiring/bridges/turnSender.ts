// The `TurnSender` bridge (16 §4.6 as extended by AMENDMENT-16, owner, 2026-10-15; 05 §4; 11 F4
// step 4; ISSUE-166): conversation → suppliers for a launched session. The dwarf's provider identity
// (crew) names its session; suppliers' `SessionChannels.sessionFor(ref)` is the only door to it, and
// `DriverSession.sendTurn` hands the turn over on stdin or the protocol, never argv (15 §1.2).
// Observed sessions are ISSUE-167's relay.
import type { DwarfId, ProviderIdentity } from '../../kernel/domain/values'
import type { TurnSender, TurnSendFailure, TurnSendResult } from '../../modules/conversation'
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
