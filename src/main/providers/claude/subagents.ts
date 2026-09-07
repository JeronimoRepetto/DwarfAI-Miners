import { join } from 'node:path'
import type { FsLike } from '../../adapters/fsLike'

/**
 * The files Claude Code writes for one session's subagents, and the one reader
 * of the sidecar beside each of them.
 *
 * Everything about an agent that is NOT in a transcript lives in
 * `<session>/subagents/agent-<id>.meta.json` (docs/provider-formats.md §1.4),
 * and two paths in this app rank an agent from it: the live board and the Mine
 * History panel. They read the same three fields for the same reasons, so the
 * reader is here rather than in either of them — the two disagreeing about one
 * agent's rank or one agent's launcher is exactly the defect #267 was, with the
 * history right and the board silent.
 *
 * Files for every depth sit FLAT in this one directory: a grandchild's
 * transcript and sidecar are named the same way as a depth-1 worker's and are
 * not nested under it (observed 2026-09-07, #267).
 */

/**
 * Bytes of a sidecar read; the real files are ~150 bytes and the largest
 * measured across 321 of them was 157 (docs/provider-formats.md §1.4).
 */
const SIDECAR_MAX_BYTES = 4 * 1024

/** Where one session's subagent transcripts and sidecars live, all depths together. */
export function claudeSubagentDir(projectDir: string, sessionId: string): string {
  return join(projectDir, sessionId, 'subagents')
}

/**
 * Where one subagent's own transcript lives. Shared by the worker dwarf's feed
 * source and by the staleness check, which reads that file's mtime as the
 * worker's own proof of life — one path shape, one place to change it.
 */
export function claudeSubagentTranscriptPath(
  projectDir: string,
  sessionId: string,
  agentId: string
): string {
  return join(claudeSubagentDir(projectDir, sessionId), `agent-${agentId}.jsonl`)
}

/** Where one subagent's sidecar lives, beside the transcript it describes. */
export function claudeSubagentSidecarPath(
  projectDir: string,
  sessionId: string,
  agentId: string
): string {
  return join(claudeSubagentDir(projectDir, sessionId), `agent-${agentId}.meta.json`)
}

/**
 * What one subagent's sidecar states, reduced to the fields this app reads.
 *
 * The file also carries `agentType`, `toolUseId`, `model` and sometimes
 * `isFork`, and it carries NO status, no completion flag and no end timestamp —
 * it is not rewritten when the agent stops, which is why nothing here may treat
 * it as a liveness or completion authority (docs/provider-formats.md §1.4).
 *
 * `spawnDepth` is 1 for a top-level spawn and N+1 below one; `parentAgentId`
 * appears on a nested agent's sidecar and is absent from a depth-1 one. Each
 * field is absent rather than defaulted when the file does not state it, so a
 * caller can tell "the sidecar says depth 1" from "the sidecar says nothing" —
 * `rankForSpawnDepth` reads the second as `worker`, never as `worker2`.
 */
export interface ClaudeSubagentSidecar {
  description?: string
  spawnDepth?: number
  parentAgentId?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * One sidecar's readable fields, or an empty record when there is no sidecar or
 * this app cannot read it.
 *
 * A missing or malformed file is not an error to report: the agent is real
 * either way — its transcript is what proved it exists — and every caller
 * already has a reading for an unstated depth and an unnamed parent. Each
 * field is validated on its own, so a file that states one of them badly does
 * not cost the others.
 */
export async function readClaudeSubagentSidecar(
  fs: FsLike,
  path: string
): Promise<ClaudeSubagentSidecar> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await fs.readTextHead(path, SIDECAR_MAX_BYTES))
  } catch {
    return {}
  }
  if (!isRecord(parsed)) return {}
  const sidecar: ClaudeSubagentSidecar = {}
  if (typeof parsed.description === 'string' && parsed.description.trim() !== '') {
    sidecar.description = parsed.description
  }
  if (typeof parsed.spawnDepth === 'number' && Number.isFinite(parsed.spawnDepth)) {
    sidecar.spawnDepth = parsed.spawnDepth
  }
  if (typeof parsed.parentAgentId === 'string' && parsed.parentAgentId !== '') {
    sidecar.parentAgentId = parsed.parentAgentId
  }
  return sidecar
}
