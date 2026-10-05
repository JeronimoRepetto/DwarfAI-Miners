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
// `saveOutcome(o: OutcomeLine)`, the port's second member over `outcome_lines`, lands with the
// outcome line and its type (later: ISSUE-102).
import type { DwarfId } from '../../../kernel/domain/values'
import type { ActivityDisclosure } from '../domain/activityRun'

/** 16 §4.6 `ActivityLog`: the members built so far. */
export interface ActivityLog {
  /** Inserts the run, or updates it in place under its id; then keeps the dwarf's newest 50 runs. */
  saveDisclosure(d: ActivityDisclosure): void
  // Amended: 16 §4.6 openRun (owner amendment A, 2026-10-05)
  /** The dwarf's open run, or null when it has none (INV-66: at most one); inside the caller's transaction. */
  openRun(dwarfId: DwarfId): ActivityDisclosure | null
}
