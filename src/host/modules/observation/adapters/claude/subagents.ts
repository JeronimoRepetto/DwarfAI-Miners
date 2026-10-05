// Where Claude Code writes a session's transcripts, and what a subagent's sidecar says (15 §5 Claude
// row; docs/provider-formats.md §1.4). Pure: names and text in, facts out.
//
// - A session's own transcript is `projects/<encoded cwd>/<sessionId>.jsonl`. The folder name is a
//   lossy encoding of the cwd (every non-alphanumeric character becomes a dash) and is never
//   decoded: the cwd comes from the records (ADR-030).
// - A subagent's transcript is `<sessionId>/subagents/agent-<agentId>.jsonl`, for every depth alike
//   (files sit flat, #267), with its sidecar `agent-<agentId>.meta.json` beside it. The sidecar is
//   the only place that names a nested agent's parent (`parentAgentId`, #391); a depth-1 agent's
//   sidecar names none, and its parent is the session. The sidecar carries no status and is never
//   a liveness or completion authority.
//
// Reimplemented from the candidate `src/main/providers/claude/subagents.ts` (R16).
import { basename, dirname, join } from 'node:path'

/** The most read of a sidecar: real ones are ~150 bytes (docs/provider-formats.md §1.4). */
export const SIDECAR_MAX_BYTES = 4 * 1024

const SESSION_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i
const SUBAGENT_FILE = /^agent-([A-Za-z0-9_-]+)\.jsonl$/
const SUBAGENTS_FOLDER = 'subagents'

/** Whether a file name can be a transcript (the folder is checked by `transcriptFileOf`). */
export function isTranscriptName(name: string): boolean {
  return SESSION_FILE.test(name) || SUBAGENT_FILE.test(name)
}

/** Which transcript a path is, or null when Claude Code does not write one there. */
export type TranscriptLocation =
  | { kind: 'session'; sessionId: string }
  | { kind: 'subagent'; sessionId: string; agentId: string; sidecarPath: string }

export function transcriptFileOf(path: string): TranscriptLocation | null {
  const name = basename(path)
  const folder = dirname(path)
  const agent = SUBAGENT_FILE.exec(name)
  if (agent !== null) {
    if (basename(folder) !== SUBAGENTS_FOLDER) return null
    const sessionId = basename(dirname(folder))
    if (sessionId === '') return null
    return {
      kind: 'subagent',
      sessionId,
      agentId: agent[1]!,
      sidecarPath: join(folder, `agent-${agent[1]!}.meta.json`)
    }
  }
  const session = SESSION_FILE.exec(name)
  if (session === null || basename(folder) === SUBAGENTS_FOLDER) return null
  return { kind: 'session', sessionId: session[1]! }
}

/** The parent agent a sidecar names, or null when it names none or cannot be read. */
export function parentAgentIdOf(sidecarText: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(sidecarText)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const parent = (parsed as Record<string, unknown>).parentAgentId
  return typeof parent === 'string' && parent !== '' ? parent : null
}
