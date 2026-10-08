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
import type { AskId, DwarfId } from '../../../kernel/domain/values'
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
