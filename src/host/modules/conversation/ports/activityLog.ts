// Driven port of conversation (05 §3.6, 16 §4.6 `ActivityLog`), type-only (05 R2): the dwarf's
// activity runs over `activity_disclosures` (09 §4.4). Every call runs inside the caller's
// transaction — the ingest batch, a turn end or a session end — and never opens its own (16 §2.2).
// The store enforces the single-open-run rule (INV-66; `activity_disclosures_one_open`) and keeps
// the newest 50 runs per dwarf, never the open one (09 §5.2 step 4), in the same transaction as the
// save (06 §9.3 consistency boundary).
//
// Amendment A to frozen 16 §4.6 (owner-approved 2026-10-05, ISSUE-101): `ActivityLog` gains
// `openRun`, the read machine 11 needs — every trigger applies to the dwarf's open run, which
// outlives a Host restart (S11.07) — through the `activity_disclosures_one_open` index (09 §4.4,
// 09 §6 index table).
//
// `saveOutcome` (16 §4.6, ISSUE-102) writes the dwarf's one outcome line over `outcome_lines`
// (09 §4.4: one row per dwarf), replacing the previous one.
//
// Amendment B to frozen 16 §4.6 (owner-approved 2026-10-05, ISSUE-102): `outcomeOf` reads the
// dwarf's stored line by the `outcome_lines` key, so a recompute knows the previous line (publish
// only on change, 08 §5.1), the running step total since the person's last message, and the last
// turn end and front ask the line carries.
//
// Amendment E to frozen 16 §4.6 (owner-approved 2026-10-06, ISSUE-108): `ConversationQueries` gains
// `outcomeOf`, served on the read connection (09 §8.1) outside any transaction, so the board's
// frames and the `dwarfs` section carry each dwarf's stored line. Its driven read is
// `ActivityLog.storedOutcomeOf` (one store port per aggregate), the one member allowed outside a
// transaction: a read-only point lookup of the `outcome_lines` key on the read connection.
// `ActivityLog.outcomeOf` stays the in-transaction read of a recompute.
import type { DwarfId } from '../../../kernel/domain/values'
import type { ActivityDisclosure } from '../domain/activityRun'
import type { OutcomeLine } from '../domain/outcomeLine'

/** 16 §4.6 `ActivityLog`. */
export interface ActivityLog {
  /** Inserts the run, or updates it in place under its id; then keeps the dwarf's newest 50 runs. */
  saveDisclosure(d: ActivityDisclosure): void
  /** Stores the dwarf's one outcome line, replacing its previous one; the same line twice changes nothing. */
  saveOutcome(o: OutcomeLine): void
  // Amended: 16 §4.6 outcomeOf (owner amendment B, 2026-10-05)
  /** The dwarf's stored outcome line, or null (the `outcome_lines` key); inside the caller's transaction. */
  outcomeOf(dwarfId: DwarfId): OutcomeLine | null
  // Amended: 16 §4.6 openRun (owner amendment A, 2026-10-05)
  /** The dwarf's open run, or null when it has none (INV-66: at most one); inside the caller's transaction. */
  openRun(dwarfId: DwarfId): ActivityDisclosure | null
  // Amended: 16 §4.6 storedOutcomeOf, the read-side half of owner amendment E (2026-10-06)
  /**
   * The dwarf's stored outcome line, or null: the one member allowed outside a transaction, a
   * read-only point lookup on the read connection (09 §8.1), behind `ConversationQueries.outcomeOf`.
   */
  storedOutcomeOf(dwarfId: DwarfId): OutcomeLine | null
}
