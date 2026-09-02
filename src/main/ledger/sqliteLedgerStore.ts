import type { WritableSqliteDb } from '../adapters/sqliteWritable'
import type { AppDatabase } from '../appDatabase/appDatabase'
import { LEDGER_VERSION, type LedgerState, type SessionMark } from '../domain/ledger'
import { emptyMaterialTotals } from '../domain/materials'
import { MATERIALS, type Material, type MaterialTotals } from '../domain/types'
import type { LedgerStore } from './ledgerStore'

/**
 * The material vault, in the app's own database instead of a JSON document
 * (#93).
 *
 * This is a STORE, not a rule. Everything that decides what is credited stays
 * in domain/ledger.ts, pure and untouched: this module only turns a LedgerState
 * into rows and back. MaterialLedger cannot tell it apart from the JSON store —
 * same two methods, same shape — which is the whole point, because that is what
 * makes the throttle, the dirty flag, the promise queue and the forced shutdown
 * save carry over with no changes at all.
 *
 * WHOLE-STATE, on purpose. save() rewrites both tables inside one transaction
 * rather than computing a row-level diff. Two reasons, and neither is laziness:
 * the state handed in IS the state — pruneSessions has already dropped whatever
 * is leaving, and a diff would have to rediscover that — and the 30-second
 * throttle (materialLedger.ts:34) already bounds this to a couple of writes a
 * minute over a table with one row per mine per material. Row-level incremental
 * writes are an optimization for a cost nobody is paying yet.
 *
 * ERROR CONTRACT, opposite to the JSON store's. createLedgerStore().load()
 * degrades an unreadable file to an empty vault, which is right for a document
 * the app can rebuild; here it would be a lie. A database that will not open
 * has not told us the vault is empty, and answering "empty" would report a
 * user's whole mined history as gone and then persist that answer over it. So
 * both methods reject, and openLedgerStore.ts is the one place that decides
 * what a rejection means.
 */

/** The one meta row: what came across from the JSON document, and when. */
export const LEDGER_MIGRATION_KEY = 'material-ledger-json'

export interface SqliteLedgerStoreOptions {
  /** The one app database, shared with the projects list. */
  database: AppDatabase
}

export function createSqliteLedgerStore(options: SqliteLedgerStoreOptions): LedgerStore {
  async function load(): Promise<LedgerState> {
    const db = await options.database.connect()
    return readLedger(db)
  }

  async function save(state: LedgerState): Promise<void> {
    const db = await options.database.connect()
    db.exec('BEGIN IMMEDIATE')
    try {
      writeLedger(db, state)
      db.exec('COMMIT')
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // A handle too broken to roll back is too broken to reuse; the next
        // connect() then reopens the file rather than replaying on a handle
        // whose transaction state nobody knows.
        options.database.invalidate()
      }
      throw error
    }
  }

  return { load, save }
}

/**
 * Rows -> ledger, defensively.
 *
 * Read back with the same suspicion parseLedger applies to the JSON document
 * (domain/ledger.ts:294-306) and for the same reason: this is a file on the
 * user's disk, and a row this build cannot make sense of must cost that row
 * rather than the whole vault. A material name this build does not know is
 * skipped — never coerced into a material it might not be — and an unusable
 * count reads as absent rather than as zero.
 */
export function readLedger(db: WritableSqliteDb): LedgerState {
  const mines: Record<string, MaterialTotals> = {}
  for (const row of db.all('SELECT mine_id, material, tokens FROM materials')) {
    const mineId = asText(row.mine_id)
    const material = asMaterial(row.material)
    const tokens = asCount(row.tokens)
    if (mineId === null || material === null || tokens === null) continue
    mines[mineId] ??= emptyMaterialTotals()
    mines[mineId][material] = tokens
  }

  const sessions: Record<string, SessionMark> = {}
  for (const row of db.all('SELECT key, tokens, seen_at FROM session_marks')) {
    const key = asText(row.key)
    const tokens = asCount(row.tokens)
    const seenAt = asCount(row.seen_at)
    // A mark missing either half cannot compute a delta, and a made-up value
    // would credit garbage on the next poll. Dropping it just rebaselines.
    if (key === null || tokens === null || seenAt === null) continue
    sessions[key] = { tokens, seenAt }
  }

  return { version: LEDGER_VERSION, mines, sessions }
}

/** How much of a state actually became rows. */
export interface LedgerRowCounts {
  /** Mines that produced at least one material row. */
  mines: number
  sessions: number
}

/**
 * Ledger -> rows. Must run inside a transaction: it empties both tables before
 * it refills them, and half of that is a vault reporting zero. Shared with the
 * migration, which needs the same rows written under the same guarantee.
 *
 * Only a material a mine has actually produced gets a row. A row therefore
 * means ore, and a mine whose every total is zero simply has no rows — which
 * costs nothing, because the only two readers of the mine key set look a mine
 * up by id (mineTotals, which answers empty for one it has never seen) or sum
 * the values (ledgerTotals).
 */
export function writeLedger(db: WritableSqliteDb, state: LedgerState): LedgerRowCounts {
  db.exec('DELETE FROM materials')
  db.exec('DELETE FROM session_marks')

  let mines = 0
  for (const [mineId, totals] of Object.entries(state.mines)) {
    let wrote = false
    for (const material of MATERIALS) {
      const tokens = totals[material]
      if (!Number.isFinite(tokens) || tokens <= 0) continue
      db.run('INSERT INTO materials (mine_id, material, tokens) VALUES (?, ?, ?)', [
        mineId,
        material,
        tokens
      ])
      wrote = true
    }
    if (wrote) mines++
  }

  let sessions = 0
  for (const [key, mark] of Object.entries(state.sessions)) {
    db.run('INSERT INTO session_marks (key, tokens, seen_at) VALUES (?, ?, ?)', [
      key,
      mark.tokens,
      mark.seenAt
    ])
    sessions++
  }

  return { mines, sessions }
}

function asText(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asMaterial(value: unknown): Material | null {
  const name = asText(value)
  if (name === null) return null
  return (MATERIALS as readonly string[]).includes(name) ? (name as Material) : null
}

/** A stored count is only honored when it is a real, non-negative, finite number. */
function asCount(value: unknown): number | null {
  const numeric = typeof value === 'bigint' ? Number(value) : value
  if (typeof numeric !== 'number') return null
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null
}
