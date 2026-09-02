import type { AppDatabase } from '../appDatabase/appDatabase'
import { parseLedger } from '../domain/ledger'
import { LEDGER_MIGRATION_KEY, writeLedger } from './sqliteLedgerStore'

/**
 * The one-time move of the material vault out of material-ledger-v1.json and
 * into the app's database (#93).
 *
 * This is the first migration of REAL user data this repository has written.
 * The document being read holds the maintainer's actual mined history plus a
 * one-time coal backfill that costs a full rescan of two transcript trees to
 * reproduce, so the whole module is built around one rule:
 *
 *   **THE JSON FILE IS NEVER TOUCHED.** Not written, not renamed, not
 *   truncated, not deleted — now or ever. It stays a valid backup of everything
 *   the vault held the moment before the database took over. That is why the
 *   only filesystem capability here is `readJson`: a single read function, with
 *   no write, rename or unlink beside it to reach for by accident.
 *
 * The document is read through parseLedger, the SAME codec the JSON store uses,
 * because its tolerance rules ARE the contract: an unknown material key is
 * ignored, an unusable count reads as zero, a session mark missing half of
 * itself is dropped, and a document from a version this build does not know
 * yields an empty vault. A migration with its own parser would be a second
 * contract, and the two would disagree the first time either changed.
 *
 * ---------------------------------------------------------------------------
 * WHY A MARKER, AND NOT "ARE THERE ANY ROWS"
 * ---------------------------------------------------------------------------
 * Row counts cannot answer this. A vault can legitimately be empty (a new
 * install), and a user who accrues nothing for a week would have their document
 * re-migrated every boot. Worse, the document's SESSION MARKS are baselines:
 * re-reading a stale one after the database has moved past it makes the next
 * poll's delta span everything mined in between and credit it a second time.
 * That is the exact class of bug domain/ledger.ts:33-41 exists to prevent, and
 * it is unrecoverable once written. So the fact "this document has been read
 * for the last time" is STORED, in one row, and its presence is the only thing
 * that makes the document ignorable.
 *
 * A document that is not there gets a marker too, for the same reason. A stale
 * backup dropped back into userData months later must be ignored, not adopted.
 */

/** What one attempt did. */
export type LedgerMigrationStatus =
  /** The document was read and its contents are now rows. */
  | 'migrated'
  /** A marker was already there; the document was not even opened. */
  | 'already-migrated'
  /** No readable document to migrate. A marker was still recorded. */
  | 'no-source'
  /** The database answered, but the write did not land. No marker; retry next boot. */
  | 'failed'

export interface LedgerMigrationOutcome {
  status: LedgerMigrationStatus
  /** Mines that carry material. For 'already-migrated', as the marker recorded it. */
  mines: number
  sessions: number
  /** Why the write did not land. Only ever set for 'failed'. */
  reason?: string
}

export interface LedgerMigrationOptions {
  /** The one app database, shared with the projects list. */
  database: AppDatabase
  /**
   * Reads the document. Read-ONLY by construction: this is the whole of this
   * module's access to the filesystem, so there is no way to modify the backup
   * from in here even by mistake.
   */
  readJson: (path: string) => Promise<string>
  /** Full path of material-ledger-v1.json, recorded in the marker as provenance. */
  jsonPath: string
  now: () => number
}

/**
 * Migrate if it has not happened, and say what it found.
 *
 * REJECTS when the database cannot be consulted at all — a corrupt file, a
 * locked one, a schema this build refuses. That is deliberately not folded into
 * 'failed': a failed WRITE leaves the marker absent, which means the document
 * is still the current copy and can be trusted for this run, while a database
 * that will not open leaves us unable to know whether it already took over.
 * openLedgerStore.ts answers those two very differently, and it can only do
 * that if they arrive differently.
 */
export async function migrateLedgerJson(
  options: LedgerMigrationOptions
): Promise<LedgerMigrationOutcome> {
  const db = await options.database.connect()

  const [marker] = db.all('SELECT mines, sessions FROM ledger_meta WHERE key = ?', [
    LEDGER_MIGRATION_KEY
  ])
  if (marker !== undefined) {
    return {
      status: 'already-migrated',
      mines: asCount(marker.mines),
      sessions: asCount(marker.sessions)
    }
  }

  let document: string | null = null
  try {
    document = await options.readJson(options.jsonPath)
  } catch {
    // Missing is the ordinary case on a fresh install; unreadable is treated
    // the same way the JSON store treats it (ledgerStore.ts:104-110). Either
    // way there is nothing to carry across, and the marker below closes the door.
    document = null
  }

  const state = parseLedger(document ?? '')

  // One transaction for the rows AND the marker. A marker without its rows
  // would make the document ignorable while the vault it described was lost;
  // rows without a marker would re-migrate on the next boot and double-credit
  // every session mark. Neither can happen if they land together.
  db.exec('BEGIN IMMEDIATE')
  try {
    const written = writeLedger(db, state)
    db.run(
      'INSERT INTO ledger_meta (key, migrated_at, source, mines, sessions) VALUES (?, ?, ?, ?, ?)',
      [LEDGER_MIGRATION_KEY, options.now(), options.jsonPath, written.mines, written.sessions]
    )
    db.exec('COMMIT')
    return { status: document === null ? 'no-source' : 'migrated', ...written }
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      options.database.invalidate()
    }
    return {
      status: 'failed',
      mines: 0,
      sessions: 0,
      reason: error instanceof Error ? error.message : 'unknown'
    }
  }
}

function asCount(value: unknown): number {
  const numeric = typeof value === 'bigint' ? Number(value) : value
  return typeof numeric === 'number' && Number.isFinite(numeric) && numeric >= 0 ? numeric : 0
}
