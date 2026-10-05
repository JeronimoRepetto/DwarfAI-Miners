// Driven port of conversation (05 §3.6, 16 §4.6 `ActivityLog`), type-only (05 R2): the dwarf's
// activity runs over `activity_disclosures` (09 §4.4). Every write runs inside the caller's
// transaction — the ingest batch, a turn end or a session end — and never opens its own (16 §2.2).
// The store enforces the single-open-run rule (INV-66; `activity_disclosures_one_open`) and keeps
// the newest 50 runs per dwarf, never the open one (09 §5.2 step 4), in the same transaction as the
// save (06 §9.3 consistency boundary).
//
// `saveOutcome(o: OutcomeLine)`, the port's second member over `outcome_lines`, lands with the
// outcome line and its type (later: ISSUE-102).
//
// Package gap resolved in development: 16 §4.6 gives `ActivityLog` no read, yet machine 11 applies
// every trigger to the dwarf's open run, which outlives a Host restart (S11.07), and 10 lists
// conversation among `activity_disclosures`' readers. `ActivityRunReader` is that read, kept off the
// frozen `ActivityLog` (the observation precedent `ObservedProcessIdentities`); the amendment
// request is to fold `openRun` into `ActivityLog`.
import type { DwarfId } from '../../../kernel/domain/values'
import type { ActivityDisclosure } from '../domain/activityRun'

/** 16 §4.6 `ActivityLog`: the members built so far. */
export interface ActivityLog {
  /** Inserts the run, or updates it in place under its id; then keeps the dwarf's newest 50 runs. */
  saveDisclosure(d: ActivityDisclosure): void
}

/** The dwarf's open run, read inside the caller's transaction (see the package gap above). */
export interface ActivityRunReader {
  /** The dwarf's open run, or null when it has none (INV-66: at most one). */
  openRun(dwarfId: DwarfId): ActivityDisclosure | null
}
