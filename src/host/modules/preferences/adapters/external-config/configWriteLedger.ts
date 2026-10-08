// The `config_writes` ledger (09 §4.8; ADR-016 item 6.6; 16 §7.3) as the config writer engine
// reads and writes it. Internal to the preferences adapters: no other module sees a row. Every
// method is synchronous and runs inside the caller's transaction (16 §2.2).
import type { Instant } from '../../../../kernel/domain/values'
import type { ConfigTarget, ConsentOrigin } from '../../ports/externalConfigWriter'

/** One `config_writes` row (06 §14 `ForeignConfigOwnership`). */
export interface ConfigWriteRow {
  id: string
  kind: ConfigTarget
  targetPath: string
  ownedMarker: string
  backupPath: string | null
  consentOrigin: ConsentOrigin
  writtenAt: Instant
  verifiedAt: Instant | null
  revertedAt: Instant | null
}

export interface ConfigWriteLedger {
  /** The live write of `kind` at `targetPath` (`reverted_at IS NULL`), at most one (`config_writes_one_active`). */
  active(kind: ConfigTarget, targetPath: string): ConfigWriteRow | null
  /** Every live write never verified: what a crash between Tx A and Tx B leaves (16 §7.3, S14.11). */
  unverified(): ConfigWriteRow[]
  /** Inserts the row, or replaces every column of the row with the same id. */
  record(row: ConfigWriteRow): void
  /** Tx B (success): the write was read back. */
  markVerified(id: string, at: Instant, backupPath: string | null): void
  /** The owned entries are gone (16 §7.4); the row is kept as the proof (09 §7.2). */
  markReverted(id: string, at: Instant): void
  /** Tx B (failure): the Tx A row is deleted, nothing was written (16 §7.3). */
  remove(id: string): void
}
