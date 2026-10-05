// Codex's own thread registry, `CODEX_HOME/state_5.sqlite` (15 §5 Codex row: identity = the thread
// id of the registry row), read through the read-only snapshot (FM-090). Pure over the rows.
//
// - The cursor is a watermark (15 §5): the highest `rowid` of `threads` read. A thread's id, cwd,
//   parent and creation never change after its row is written, so a new row is the only news;
//   `SourceFile.size` of the database is its highest rowid, so a value below the cursor is a
//   rebuilt file (FM-087).
// - An archived thread is not a session. `threads.cwd` loses its `\\?\` prefix (`parse.ts`), and
//   the parent is the one `threads.source` names when it is the sub-agent spawn object.
// - A row without an id or cwd is skipped with a warning; a query the schema cannot answer (an
//   older or newer Codex) throws, and the adapter reports it as a warning, never fatal (INV-38).
//
// Not read: `logs_2.sqlite`. The candidate used its rows as a liveness heartbeat because a rollout
// kept open keeps its old mtime on Windows; the observation loop reads by size, never by mtime,
// so a rollout's growth is already the live signal and no fact of 16 §4.3 comes from that file.
import type { FolderPath, ProviderId } from '../../../../kernel/domain/values'
import type { SqliteRow } from '../../../../kernel/ports/sqliteDatabase'
import type { ObservedEvent } from '../../ports/observationAdapter'
import { normalizeCodexCwd, parentThreadOf } from './parse'

/** The registry's file name under `CODEX_HOME` (15 §5). */
export const CODEX_STATE_FILE = 'state_5.sqlite'

/** The highest rowid of the registry: the size of the database source. */
export const MAX_ROW_SQL = 'SELECT MAX(rowid) AS max_row FROM threads'

/** The rows past a watermark, oldest first. */
export const THREADS_SINCE_SQL =
  'SELECT rowid AS row_id, id, cwd, source, archived, created_at, created_at_ms ' +
  'FROM threads WHERE rowid > ? ORDER BY rowid'

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'bigint') return Number(value)
  return undefined
}

/** The highest rowid a `MAX_ROW_SQL` answer holds (0 for an empty registry). */
export function maxRowOf(rows: readonly SqliteRow[]): number {
  return asNumber(rows[0]?.['max_row']) ?? 0
}

/** The sessions of registry rows read past `watermark`, and the watermark after them. */
export function sessionsOfThreadRows(
  rows: readonly SqliteRow[],
  watermark: number,
  providerId: ProviderId
): { events: ObservedEvent[]; watermark: number; warnings: string[] } {
  const events: ObservedEvent[] = []
  const warnings: string[] = []
  let highest = watermark
  for (const row of rows) {
    const rowId = asNumber(row['row_id'])
    if (rowId === undefined) continue
    highest = Math.max(highest, rowId)
    if (asNumber(row['archived']) === 1) continue
    const id = asString(row['id'])
    const cwd = asString(row['cwd'])
    if (id === undefined || cwd === undefined) {
      warnings.push(`unreadable thread row ${rowId}`)
      continue
    }
    const createdMs = asNumber(row['created_at_ms'])
    const createdS = asNumber(row['created_at'])
    const at = createdMs ?? (createdS === undefined ? undefined : createdS * 1000)
    if (at === undefined) {
      warnings.push(`thread row ${rowId} without a creation time`)
      continue
    }
    const parent = parentThreadOf(row['source'])
    const normalized = normalizeCodexCwd(cwd) as FolderPath
    events.push({
      kind: 'session',
      sourceEventId: `thread:${id}`,
      identity: { providerId, providerSessionId: id },
      cwd: normalized,
      at,
      ...(parent === null ? {} : { parentIdentity: { providerId, providerSessionId: parent } })
    })
  }
  return { events, watermark: highest, warnings }
}
