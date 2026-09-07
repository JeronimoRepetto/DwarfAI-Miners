import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Test support for seeding a MemorySqlite with Codex's real SQLite shapes.
 *
 * The schemas are the verbatim CREATE TABLE statements captured from a live
 * Codex 0.150.1 CODEX_HOME (see docs/codex-v2-format.md), so provider tests
 * run the production SQL against the real column names and types rather than
 * a hand-written approximation.
 */

const FIXTURES = join(import.meta.dirname, '..', '__fixtures__', 'codex')

export const CODEX_STATE_SCHEMA = readFileSync(join(FIXTURES, 'state-schema.sql'), 'utf8')
export const CODEX_LOGS_SCHEMA = readFileSync(join(FIXTURES, 'logs-schema.sql'), 'utf8')

function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

export interface ThreadSeed {
  id: string
  cwd: string
  rolloutPath?: string
  /** Freshness the registry reports; the whole point is that it is not the file mtime. */
  updatedAtMs?: number
  recencyAtMs?: number
  /**
   * When the row was created. Nullable in the real schema exactly as
   * `updated_at_ms` is, and the only stamp a just-opened thread is certain to
   * carry (#264) — a relaunched session's row can reach the first scan with
   * `updated_at_ms` still NULL and `recency_at_ms` at its 0 default.
   */
  createdAtMs?: number
  model?: string
  effort?: string
  tokensUsed?: number
  /** Plain "cli"/"vscode", or the JSON sub-agent spawn blob. */
  source?: string
  /** The Codex build that opened the thread; blank, as the column defaults, unless stated. */
  cliVersion?: string
  agentNickname?: string
  archived?: number
}

/** One INSERT against the real `threads` shape, defaulting every NOT NULL column. */
export function threadInsert(seed: ThreadSeed): string {
  const columns: Record<string, string> = {
    id: quote(seed.id),
    rollout_path: quote(seed.rolloutPath ?? `C:\\rollouts\\rollout-${seed.id}.jsonl`),
    created_at: '0',
    updated_at: '0',
    source: quote(seed.source ?? 'cli'),
    cli_version: quote(seed.cliVersion ?? ''),
    model_provider: quote('openai'),
    cwd: quote(seed.cwd),
    title: quote(''),
    sandbox_policy: quote(''),
    approval_mode: quote(''),
    tokens_used: String(seed.tokensUsed ?? 0),
    archived: String(seed.archived ?? 0),
    model: seed.model === undefined ? 'NULL' : quote(seed.model),
    reasoning_effort: seed.effort === undefined ? 'NULL' : quote(seed.effort),
    agent_nickname: seed.agentNickname === undefined ? 'NULL' : quote(seed.agentNickname),
    created_at_ms: seed.createdAtMs === undefined ? 'NULL' : String(seed.createdAtMs),
    updated_at_ms: seed.updatedAtMs === undefined ? 'NULL' : String(seed.updatedAtMs),
    recency_at_ms: String(seed.recencyAtMs ?? 0)
  }
  const names = Object.keys(columns).join(', ')
  const values = Object.values(columns).join(', ')
  return `INSERT INTO threads (${names}) VALUES (${values})`
}

/**
 * The JSON blob Codex stores in `threads.source` for a spawned sub-agent.
 *
 * `agentPath` is the agent definition the spawn names, and the only field that
 * states what the child was asked to do (#218) — its fork carries the human's
 * original prompt rather than the parent's instruction.
 */
export function subagentSource(
  parentThreadId: string,
  agentNickname?: string,
  agentPath = '/root/audit'
): string {
  return JSON.stringify({
    subagent: {
      thread_spawn: {
        parent_thread_id: parentThreadId,
        depth: 1,
        agent_path: agentPath,
        agent_nickname: agentNickname ?? null,
        agent_role: null
      }
    }
  })
}

export function spawnEdgeInsert(
  parentThreadId: string,
  childThreadId: string,
  status = 'open'
): string {
  return (
    'INSERT INTO thread_spawn_edges (parent_thread_id, child_thread_id, status) VALUES ' +
    `(${quote(parentThreadId)}, ${quote(childThreadId)}, ${quote(status)})`
  )
}

/** One `logs` heartbeat row. `tsSeconds` is UNIX SECONDS, as Codex stores it. */
export function logInsert(threadId: string | null, tsSeconds: number): string {
  const thread = threadId === null ? 'NULL' : quote(threadId)
  return (
    'INSERT INTO logs (ts, ts_nanos, level, target, thread_id) VALUES ' +
    `(${Math.floor(tsSeconds)}, 0, 'INFO', 'codex_core::session', ${thread})`
  )
}
