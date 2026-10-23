import { createHash } from 'node:crypto'
import path from 'node:path'

/**
 * The files a demo foreman's CLI writes for its subagents, in the shapes the real CLIs write and the Host's observer
 * reads (`stubs/subagents.test.mjs` reads them back with the Host's own readers):
 *
 * - Claude Code: a subagent's transcript `projects/<encoded cwd>/<session>/subagents/agent-<agentId>.jsonl` with its
 *   sidecar `agent-<agentId>.meta.json`, which names a nested agent's parent (`parentAgentId`), and the task
 *   notification in the session's own transcript that ends it (`observation/adapters/claude/subagents.ts`,
 *   `reconcile.ts`; docs/provider-formats.md §1.4).
 * - Codex: a sub-thread is a rollout of its own whose `session_meta.source` names its parent thread
 *   (`subagent.thread_spawn.parent_thread_id`, `observation/adapters/codex/parse.ts`).
 *
 * The Host ranks each from its parent: the foreman's subagent is a worker, a worker's subagent a worker²
 * (`wiring/routes/crew.ts`). Nothing here starts a process: a subagent runs inside its foreman's CLI.
 */

const hashOf = (text) => createHash('sha1').update(text).digest('hex')

/** A stable Claude agent id for `seed` (the session and the worker's key): `a` and 16 hex digits. */
export function agentIdOf(seed) {
  return `a${hashOf(seed).slice(0, 16)}`
}

/** A stable Codex thread id (a UUID) for `seed`. */
export function threadIdOf(seed) {
  const h = hashOf(seed)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-7${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`
}

/** Claude Code's lossy folder name for a cwd: every non-alphanumeric character becomes a dash. */
export function encodeCwd(cwd) {
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}

/** The session's own transcript under a Claude config folder. */
export function claudeSessionFile(configDir, cwd, sessionId) {
  return path.join(configDir, 'projects', encodeCwd(cwd), `${sessionId}.jsonl`)
}

/** A subagent's transcript and sidecar under a Claude config folder. */
export function claudeSubagentFiles(configDir, cwd, sessionId, agentId) {
  const folder = path.join(configDir, 'projects', encodeCwd(cwd), sessionId, 'subagents')
  return {
    transcript: path.join(folder, `agent-${agentId}.jsonl`),
    sidecar: path.join(folder, `agent-${agentId}.meta.json`)
  }
}

/** A subagent's sidecar: a nested one names its parent agent and a deeper spawn depth. */
export function claudeSidecar(description, toolUseId, parentAgentId) {
  return {
    agentType: 'general-purpose',
    description,
    toolUseId,
    ...(parentAgentId === null ? { spawnDepth: 1 } : { parentAgentId, spawnDepth: 2 })
  }
}

/** The harness's notification, in the session's own transcript, that the agent `agentId` completed. */
export function taskNotification(sessionId, cwd, agentId, summary, at) {
  return {
    type: 'queue-operation',
    operation: 'enqueue',
    timestamp: new Date(at).toISOString(),
    sessionId,
    cwd,
    content: [
      '<task-notification>',
      `<task-id>${agentId}</task-id>`,
      '<status>completed</status>',
      `<summary>${summary}</summary>`,
      '</task-notification>'
    ].join('\n')
  }
}

/** The head of a Codex sub-thread's rollout: its own id, its cwd and the thread that spawned it. */
export function codexSubthreadMeta(threadId, parentThreadId, cwd, at) {
  const timestamp = new Date(at).toISOString()
  return {
    timestamp,
    type: 'session_meta',
    payload: {
      id: threadId,
      session_id: threadId,
      timestamp,
      cwd,
      originator: 'codex_vscode',
      cli_version: '0.153.4',
      source: { subagent: { thread_spawn: { parent_thread_id: parentThreadId, depth: 1 } } }
    }
  }
}

/** A rollout file under a Codex home: `sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl`. */
export function codexRolloutFile(codexHome, threadId, at) {
  const iso = new Date(at).toISOString()
  const stamp = iso.slice(0, 19).replaceAll(':', '-')
  return path.join(
    codexHome,
    'sessions',
    ...iso.slice(0, 10).split('-'),
    `rollout-${stamp}-${threadId}.jsonl`
  )
}
