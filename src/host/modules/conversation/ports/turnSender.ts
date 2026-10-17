// Driven port of conversation (05 §3.6, 16 §4.6 `TurnSender`), type-only (05 R2): hands one turn to
// the dwarf's session — the bridge to suppliers `SessionChannels.sessionFor(ref).sendTurn` for a
// launched session (host/wiring/bridges/turnSender.ts), the observed-session relay later
// (ISSUE-167).
//
// AMENDMENT-16 extension (owner, 2026-10-15): `send` takes `15` §1.2 `TurnInput` (the package named
// an undefined `OutgoingTurn`) and answers the `SendReceipt` facts plus the session's
// `reactionEvidence` (ADR-009 D2), its failures shaped as `DriverSendError`, so the ✓ mark carries
// the channel's confidence, a queued turn stays "…" (S7.03), and ✓✓ can be tied to the turn that
// consumed this input (ADR-022 item 3, S7.05).
import type { DwarfId } from '../../../kernel/domain/values'
import type { SendReceipt, TurnInput } from '../../suppliers'
import type { ReactionEvidence } from '../domain/delivery'

/** What the session reported for an accepted turn. */
export interface TurnHandOver {
  confidence: SendReceipt['confidence']
  heldUntilTurnEnd: boolean
  correlation: string
  providerTurnId?: string
  reactionEvidence: ReactionEvidence
}

/** `15` §1.2 `DriverSendError`, as the delivery failure it becomes (ADR-022 item 1). */
export type TurnSendFailure = { kind: 'channel-error'; reason: string } | { kind: 'session-closed' }

export type TurnSendResult =
  { ok: true; value: TurnHandOver } | { ok: false; error: TurnSendFailure }

export interface TurnSender {
  send(dwarfId: DwarfId, turn: TurnInput): Promise<TurnSendResult>
}
