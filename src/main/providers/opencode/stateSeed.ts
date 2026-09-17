import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Test support for seeding a `MemorySqlite` with OpenCode's real SQLite
 * shapes — the schemas are the verbatim `CREATE TABLE` statements captured
 * from a live 1.18.31 `opencode.db` (see `docs/opencode-format.md`), so
 * provider tests run the production SQL against the real column names and
 * types instead of a hand-written approximation. Mirrors `codex/stateSeed.ts`.
 */

const FIXTURES = join(import.meta.dirname, '..', '__fixtures__', 'opencode')

export const OPENCODE_SCHEMA = readFileSync(join(FIXTURES, 'opencode-schema.sql'), 'utf8')
export const OPENCODE_UNKNOWN_SCHEMA = readFileSync(
  join(FIXTURES, 'opencode-unknown-schema.sql'),
  'utf8'
)

function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

export interface SessionSeed {
  id: string
  directory: string
  parentId?: string
  title?: string
  agent?: string
  /** The raw `session.model` JSON string, e.g. `{"id":"x","providerID":"y"}`. */
  model?: string
  timeCreatedMs?: number
  timeUpdatedMs?: number
  /** Present only for an archived session — excluded by `readOpenCodeSessions`. */
  timeArchivedMs?: number
}

/** One INSERT against the real `session` shape, defaulting every NOT NULL column. */
export function sessionInsert(seed: SessionSeed): string {
  const columns: Record<string, string> = {
    id: quote(seed.id),
    project_id: quote('prj_placeholder'),
    workspace_id: 'NULL',
    parent_id: seed.parentId === undefined ? 'NULL' : quote(seed.parentId),
    slug: quote('sample-project'),
    directory: quote(seed.directory),
    path: quote(''),
    title: quote(seed.title ?? ''),
    version: quote('1.18.31'),
    cost: '0',
    tokens_input: '0',
    tokens_output: '0',
    tokens_reasoning: '0',
    tokens_cache_read: '0',
    tokens_cache_write: '0',
    agent: seed.agent === undefined ? 'NULL' : quote(seed.agent),
    model: seed.model === undefined ? 'NULL' : quote(seed.model),
    time_created: String(seed.timeCreatedMs ?? 0),
    time_updated: String(seed.timeUpdatedMs ?? 0),
    time_archived: seed.timeArchivedMs === undefined ? 'NULL' : String(seed.timeArchivedMs)
  }
  const names = Object.keys(columns).join(', ')
  const values = Object.values(columns).join(', ')
  return `INSERT INTO session (${names}) VALUES (${values})`
}

export interface MessageSeed {
  id: string
  sessionId: string
  timeCreatedMs: number
  /** Whatever `message.data` should hold; stored as its JSON string, as the real column is. */
  data: unknown
}

/** One INSERT against the real `message` shape. */
export function messageInsert(seed: MessageSeed): string {
  return (
    'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ' +
    `(${quote(seed.id)}, ${quote(seed.sessionId)}, ${seed.timeCreatedMs}, ${seed.timeCreatedMs}, ${quote(JSON.stringify(seed.data))})`
  )
}

export interface PartSeed {
  id: string
  messageId: string
  sessionId: string
  timeCreatedMs: number
  data: unknown
}

/** One INSERT against the real `part` shape. */
export function partInsert(seed: PartSeed): string {
  return (
    'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ' +
    `(${quote(seed.id)}, ${quote(seed.messageId)}, ${quote(seed.sessionId)}, ${seed.timeCreatedMs}, ${seed.timeCreatedMs}, ${quote(JSON.stringify(seed.data))})`
  )
}

/** One INSERT against the real `event` shape — the activity signal `seq` grows on. */
export function eventInsert(
  id: string,
  aggregateId: string,
  seq: number,
  type = 'message.part.updated.1'
): string {
  return (
    'INSERT INTO event (id, aggregate_id, seq, type, data) VALUES ' +
    `(${quote(id)}, ${quote(aggregateId)}, ${seq}, ${quote(type)}, ${quote('{}')})`
  )
}
