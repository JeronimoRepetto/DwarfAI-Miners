// Driven port of observation (05 §3.3, 16 §4.3 `ObservedSessionStore`): the observed-session index
// `ProviderIdentity → DwarfId` (ADR-015 item 7) over `observed_sessions` and
// `observed_session_streams` (09 §4.2). Written only by observation, inside the caller's
// transaction (16 §2.2). Type-only (05 §2.2).
//
// Package gap: the package names `ObservedSession`, `ObservedSessionStream` and
// `ObservedSessionRef` but gives no fields; 06 §6.1 lists the aggregate's, used here. The identity
// is the dwarf's own UNIQUE key (09 §4.2 stores it on `dwarfs` only: `observed_sessions` has no
// identity column), so `byIdentity` reads the index through that key and answers the dwarf bound
// to an identity even before observation saved its row. That is how the loop learns the `DwarfId`
// that `crew.arrive` minted for a session it observed (05 §4 route `SessionObserved →
// mines.resolveForSession → crew.arrive`) while it never writes crew state (INV-37):
//
// - a saved row answers its own fields;
// - a bound dwarf with no row yet answers `cwd` = its mine's folder, `firstSeenAt` =
//   `lastRecordAt` = its arrival, and `closedAt` = its departure (null while present);
// - a saved row of a departed dwarf answers its departure as `closedAt` when it has none itself
//   (S4.35: a session ended by DwarfAI is closed for observation too, S4.40).
import type { DwarfId, FolderPath, Instant, ProviderIdentity } from '../../../kernel/domain/values'

/** 06 §6.1 `ObservedSession`, one per identity. */
export interface ObservedSession {
  identity: ProviderIdentity
  dwarfId: DwarfId
  cwd: FolderPath
  firstSeenAt: Instant
  lastRecordAt: Instant
  closedAt: Instant | null
}

/** One stream feeding an observed session (`observed_session_streams`). */
export interface ObservedSessionStream {
  dwarfId: DwarfId
  streamId: string
}

/** What the module answers about an observed dwarf (16 §4.3 `ObservationQueries`). */
export interface ObservedSessionRef {
  dwarfId: DwarfId
  /** The streams that feed it (at least one), by stream id. */
  streamIds: readonly string[]
}

export interface ObservedSessionStore {
  // observed_sessions + observed_session_streams (09 §4): ProviderIdentity → DwarfId index
  byIdentity(i: ProviderIdentity): ObservedSession | null
  save(s: ObservedSession): void // inside the caller's transaction
  /** The streams of the observed session `sessionId` (its `DwarfId`), by stream id. */
  streams(sessionId: string): ObservedSessionStream[]
  saveStream(s: ObservedSessionStream): void
}
