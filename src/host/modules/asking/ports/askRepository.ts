// Driven port (05 §3.7, 16 §4.7): the persisted asks (09 §4.5 `asks`, `ask_answers`). ADR-010
// item 9: a row is written on open, on every state change and on every step change, so an open
// ask survives the window closing and the Host restarting; it holds the text needed to redraw its
// card and its current step, never the options picked on earlier steps (INV-75, OQ-03).
// `SqliteAskRepository` and `InMemoryAskRepository` run `runAskRepositoryContract`.
//
// - `openFor(dwarfId)`: the dwarf's front ask, the oldest one still `open` or `answering`
//   (ADR-010 item 7 FIFO; 09 `asks_live`), or null.
// - `byProviderRequest(channel, providerRequestId)`: the ask of that dwarf's provider request in
//   any state, the INV-71 key (`asks` UNIQUE `(dwarf_id, provider_request_id)`).
// - `save(ask)`: upserts by `ask.id`; a second ask with another id on the same
//   `(dwarfId, providerRequestId)` is refused like the UNIQUE constraint refuses it.
// - `settle(askId, outcome)`: the critical-section primitive (09 §8.2, INV-72): `open` →
//   `answering` and the pending `ask_answers` row, or `'already-settled'` with nothing written.
//   Writes run inside the caller's transaction (16 §2.2).
//
// Package gap (resolved in ISSUE-127): 05/16 name `AskChannelRef` and `AskSettlement` without
// defining them. `AskChannelRef` carries the one thing the `asks` key needs besides the provider's
// request id, the dwarf the caller already resolved (16 §4.7 `open` row; 08 §4). `AskSettlement`
// carries the `ask_answers` primary key, the submit's `requestId` (INV-79); the row's `at` comes from
// the kernel `Clock` and its `message_id` stays NULL until the answers-record is linked (later:
// ISSUE-128).
//
// Owner amendment K (2026-10-09, ISSUE-128): the `ask_answers` reads and writes the two answer paths
// need (ADR-010 items 4, 5, 13; 09 §8.2; INV-79) — `answerOf`, `recordOf`, `linkRecord`,
// `settleAnswer` — and `byId`, the critical section's read of the submitted ask (09 §8.2 "read the
// ask's state"). Every write joins the caller's transaction.
import type { AnswerOutcome } from '../../../kernel/domain/sharedContracts'
import type { AskId, DwarfId, MessageId } from '../../../kernel/domain/values'
import type { Ask } from '../domain/ask'

/** Which dwarf's answer channel a provider request arrived on (05 §3.7 `AskChannelRef`). */
export interface AskChannelRef {
  readonly dwarfId: DwarfId
}

/** What a settle records: the submit that won the ask (`ask_answers.request_id`, 09 §4.5). */
export interface AskSettlement {
  readonly requestId: string
}

// verbatim: 05-modules-and-ports.md L904-L909 (16 §4.7; `prettier-ignore` keeps its alignment)
// prettier-ignore
export interface AskRepository {
  openFor(dwarfId: DwarfId): Ask | null
  byProviderRequest(channel: AskChannelRef, providerRequestId: string): Ask | null
  save(ask: Ask): void
  settle(askId: AskId, outcome: AskSettlement): 'settled' | 'already-settled'   // the one critical section (HO-16)
}
// end verbatim

/** A submit's `ask_answers` row (09 §4.5): its ask, its outcome once settled, its answers-record. */
export interface AskAnswer {
  readonly askId: AskId
  /** Null while the hand-over is in flight (`outcome` NULL). */
  readonly outcome: AnswerOutcome | null
  /** Null until linked, and again once the record was trimmed (`ON DELETE SET NULL`). */
  readonly messageId: MessageId | null
}

/** What a hand-over settles to (`ask_answers.outcome`): `not-open` is never stored (ADR-010 item 5). */
export type SettledAnswer = Exclude<AnswerOutcome, { kind: 'not-open' }>

/**
 * Owner amendment K (2026-10-09): the members `AskRepository` gains, each marked where it is
 * declared. Kept apart from the verbatim owner block above so that block stays byte-identical.
 */
export interface AskRepository {
  // Amended: 16 §4.7 AskRepository.byId (owner amendment K, 2026-10-09): the submitted ask in any
  // state, the critical section's read (09 §8.2); a UI submit names only its `askId` (14 §3.4).
  byId(askId: AskId): Ask | null
  // Amended: 16 §4.7 AskRepository.answerOf (owner amendment K, 2026-10-09): the `ask_answers` row
  // of a `requestId` that won its ask, or null — INV-79's durable first result.
  answerOf(requestId: string): AskAnswer | null
  // Amended: 16 §4.7 AskRepository.recordOf (owner amendment K, 2026-10-09): the answers-record an
  // earlier submit of the ask linked, for the in-place re-answer (ADR-010 item 13), or null.
  recordOf(askId: AskId): MessageId | null
  // Amended: 16 §4.7 AskRepository.linkRecord (owner amendment K, 2026-10-09): transaction 1 —
  // the winning request's `ask_answers.message_id`.
  linkRecord(requestId: string, messageId: MessageId): void
  // Amended: 16 §4.7 AskRepository.settleAnswer (owner amendment K, 2026-10-09): transaction 2 —
  // `outcome`, `refusal_reason` and `settled_at` of the winning request, once.
  settleAnswer(requestId: string, result: SettledAnswer): void
}
