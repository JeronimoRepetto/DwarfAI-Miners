// Kernel driven port (ADR-002 D8 items 2–3; 07 S12.14, S12.15; lead decision 2026-09-30 in
// ISSUE-032): what the upgrade drain asks before it may checkpoint and exit. The drain waits for
// "no launched session with an open turn, no open ask, nothing in flight" (item 2) and for every
// session whose driver cannot resume to end (item 3): facts owned by the launching (EPIC-10) and
// asking (EPIC-08) modules. `blockers()` reports what holds the drain right now; an empty list lets
// it go. It only reads: asking never ends, interrupts or changes anything (the drain waits, it
// never interrupts a session, ADR-002 D8 items 3–4).
//
// host/main.ts binds the empty implementation of cut 0, where no session exists, so the drain
// goes at once (host/wiring/emptyDrainGate.ts); EPIC-10 and EPIC-08 bind their blockers later.
import type { DwarfId } from '../../../contracts/wire'

/** What can hold the drain (ADR-002 D8 items 2–3). */
export type DrainBlockerKind =
  /** A launched session has an open turn. */
  | 'open-turn'
  /** An ask is open. */
  | 'open-ask'
  /** A launch or a delivery is in flight. */
  | 'in-flight'
  /** A launched session whose driver cannot resume is alive: it holds the drain until it ends. */
  | 'non-resumable-session'

export interface DrainBlocker {
  kind: DrainBlockerKind
  /** The dwarf it belongs to, when it belongs to one (an opaque id, loggable, ADR-026). */
  dwarfId?: DwarfId
}

export interface DrainGate {
  /** What holds the drain right now; empty when nothing does. */
  blockers(): readonly DrainBlocker[]
}
