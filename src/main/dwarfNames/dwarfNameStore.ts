import type { AppDatabase } from '../appDatabase/appDatabase'
import { PANEL_OBSERVER, isDwarfProvider, type DwarfObserver } from '../domain/types'
import { cleanDwarfName } from '../../shared/dwarfName'

/**
 * The names a person gave dwarfs, as they survive between runs (#635, decision log "Dwarf
 * names"): per machine, in the app database, never synced.
 *
 * A STORE, not a rule, like the launch register beside it in that file. What a save may hold and
 * when it removes a name is `cleanDwarfName` and `customNameFor`'s (shared/dwarfName.ts); which
 * dwarf a save names is the runtime's, against its own board. This module turns one name into a
 * row and back.
 *
 * ROW BY ROW: a name is given or reset one dwarf at a time, minutes or days apart.
 *
 * ERROR CONTRACT, the same as every other tenant's. A database that will not open has not said
 * nobody renamed anything, so every method rejects and the caller decides what that means.
 *
 * A custom name is user data, so nothing here logs one, raw or cleaned, and neither may a caller.
 */

/** One dwarf's custom name, as it survives between runs. */
export interface PersistedDwarfName {
  /** The dwarf id the providers build (`claude:<session>`, `codex:<thread>`, ...) — the key. */
  dwarfId: string
  /** Who drew the dwarf when it was named. Bookkeeping, never part of the key. */
  provider: DwarfObserver
  /** Already cleaned: a row holds only what `cleanDwarfName` would have saved. */
  customName: string
  /** When the name was given, epoch ms. */
  setAt: number
}

export interface DwarfNameStore {
  /** Every name kept, in no particular order. Rejects; never lies with []. */
  list(): Promise<PersistedDwarfName[]>
  /** Keep one dwarf's name, replacing whatever it had. */
  put(name: PersistedDwarfName): Promise<void>
  /** Forget one dwarf's name, whether or not it had one. */
  remove(dwarfId: string): Promise<void>
}

export interface SqliteDwarfNameStoreOptions {
  /** The one app database, shared with the projects list, the vault and the launch register. */
  database: AppDatabase
}

const SELECT_ALL = 'SELECT dwarf_id, provider, custom_name, set_at FROM dwarf_names'

const UPSERT =
  'INSERT OR REPLACE INTO dwarf_names (dwarf_id, provider, custom_name, set_at) VALUES (?, ?, ?, ?)'

export function createSqliteDwarfNameStore(options: SqliteDwarfNameStoreOptions): DwarfNameStore {
  return {
    async list(): Promise<PersistedDwarfName[]> {
      const db = await options.database.connect()
      const names: PersistedDwarfName[] = []
      for (const row of db.all(SELECT_ALL)) {
        const name = toName(row)
        if (name !== null) names.push(name)
      }
      return names
    },

    async put(name: PersistedDwarfName): Promise<void> {
      const db = await options.database.connect()
      db.run(UPSERT, [name.dwarfId, name.provider, name.customName, name.setAt])
    },

    async remove(dwarfId: string): Promise<void> {
      const db = await options.database.connect()
      db.run('DELETE FROM dwarf_names WHERE dwarf_id = ?', [dwarfId])
    }
  }
}

/**
 * Names for the life of this store and no longer (handoff, "Dwarf names in the app"): what a
 * simulated valley uses, since its dwarfs are invented for one run, and what the app falls back
 * to when its database will not open, so renaming still works for the run it is in.
 */
export function createMemoryDwarfNameStore(): DwarfNameStore {
  const names = new Map<string, PersistedDwarfName>()
  return {
    async list() {
      return [...names.values()].map((name) => ({ ...name }))
    },
    async put(name) {
      names.set(name.dwarfId, { ...name })
    },
    async remove(dwarfId) {
      names.delete(dwarfId)
    }
  }
}

/**
 * One row -> one name, or nothing. A row whose name is not exactly what `cleanDwarfName` would
 * have saved — edited by hand, or written under other rules — is dropped rather than repaired:
 * showing it would be this build vouching for a name it never cleaned.
 */
function toName(row: Record<string, unknown>): PersistedDwarfName | null {
  const dwarfId = asText(row.dwarf_id)
  const provider = asObserver(row.provider)
  const customName = asText(row.custom_name)
  const setAt = asPositive(row.set_at)
  if (dwarfId === null || provider === null || customName === null || setAt === null) return null
  if (cleanDwarfName(customName) !== customName) return null
  return { dwarfId, provider, customName, setAt }
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function asObserver(value: unknown): DwarfObserver | null {
  if (value === PANEL_OBSERVER) return PANEL_OBSERVER
  return isDwarfProvider(value) ? value : null
}

// node:sqlite can hand an INTEGER column back as a number or a bigint (see launchedSessionStore).
function asPositive(value: unknown): number | null {
  const numeric = typeof value === 'bigint' ? Number(value) : value
  if (typeof numeric !== 'number') return null
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null
}
