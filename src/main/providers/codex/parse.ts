import { toolActivityLine } from '../../domain/permissionSummary'
import type { FeedMessage } from '../../domain/types'

/**
 * Pure parsers for Codex CLI rollout files (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl).
 * Every record is {timestamp, type, payload} — see docs/provider-formats.md.
 */

/** Session identity from the session_meta record (line 1 of a rollout). */
export interface CodexRolloutHead {
  sessionId: string
  cwd: string
  /** Present only for a Codex subagent spawned by another thread. */
  parentSessionId?: string
  /** Provider-supplied nickname for a spawned Codex subagent. */
  agentName?: string
}

/** Live state read from the tail of a rollout. */
export interface CodexRolloutInfo {
  model?: string
  effort?: string
  /** True when the last task_started has no matching task_complete or turn_aborted. */
  busy: boolean
  /**
   * True when this fragment carries a `task_complete` and no turn was reopened
   * after it — Codex's own record that a turn ENDED, rather than the absence of
   * evidence that one is running (#219).
   *
   * `busy: false` cannot answer that question: it is equally what a rollout
   * with no turn events at all looks like, which is a thread whose session_meta
   * is on disk but whose first `task_started` is not yet. The provider retires
   * a finished sub-agent on this field, so it must never be true for a thread
   * that has not spoken.
   *
   * `turn_aborted` deliberately does not set it, though it closes the turn for
   * `busy` (issue #34): an interrupt is a human's decision about what happens
   * next, and reading it as "finished" would be this app making that decision
   * instead.
   */
  completedTurn: boolean
  lastMessage?: string
}

/** Model settings found in one or more `turn_context` records. */
export interface CodexRolloutContext {
  model?: string
  effort?: string
}

type Rec = Record<string, unknown>

function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function jsonlRecords(text: string): { type: string; payload: Rec; timestamp: string }[] {
  const records: { type: string; payload: Rec; timestamp: string }[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (isRecord(parsed) && typeof parsed.type === 'string' && isRecord(parsed.payload)) {
        records.push({
          type: parsed.type,
          payload: parsed.payload,
          timestamp: asString(parsed.timestamp) ?? ''
        })
      }
    } catch {
      // partial or corrupt line — skip
    }
  }
  return records
}

/** Parse the head of a rollout for the session_meta identity; null when absent. */
export function parseCodexRolloutHead(headText: string): CodexRolloutHead | null {
  for (const record of jsonlRecords(headText)) {
    if (record.type !== 'session_meta') continue
    const sessionId = asString(record.payload.id) ?? asString(record.payload.session_id)
    const cwd = asString(record.payload.cwd)
    if (sessionId === undefined || cwd === undefined) return null
    const source = record.payload.source
    const subagent = isRecord(source) ? source.subagent : undefined
    const threadSpawn = isRecord(subagent) ? subagent.thread_spawn : undefined
    const head: CodexRolloutHead = { sessionId, cwd }
    if (isRecord(threadSpawn)) {
      const parentSessionId = asString(threadSpawn.parent_thread_id)
      const agentName = asString(threadSpawn.agent_nickname)
      if (parentSessionId !== undefined) head.parentSessionId = parentSessionId
      if (agentName !== undefined) head.agentName = agentName
    }
    return head
  }
  return null
}

const STORAGE_DATE_SEGMENT_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * True when `cwd` is shaped like Codex's own artifact-storage folder —
 * `.../Documents/Codex/<YYYY-MM-DD>/<slug>` — rather than a real working
 * directory (issue #166).
 *
 * Verified live on the maintainer's machine (2026-09-03): a "Codex Desktop"
 * session (`session_meta.payload.originator`, `source: "vscode"`) asked
 * about a real repository the user never opened as its bound workspace
 * wrote exactly this shape as its own `session_meta.cwd` — a sibling rollout
 * from the same window, for a session that DID have a bound folder, carried
 * the real repository path in the same field instead. So this is not a
 * parsing bug fixable by reading a different field: for a session shaped
 * this way, Codex itself never recorded any other cwd, and laundering the
 * storage path as a project is exactly the phantom-project failure the
 * issue reports. `parseCodexRolloutHead`/the registry's `threads.cwd` both
 * feed this — same string, same check.
 *
 * Windows-verified only. macOS/Linux equivalents are unconfirmed; see
 * docs/codex-v2-format.md.
 */
export function isCodexArtifactStorageCwd(cwd: string): boolean {
  const segments = cwd.split(/[\\/]+/).filter((segment) => segment !== '')
  if (segments.length < 4) return false
  const slug = segments[segments.length - 1]
  const date = segments[segments.length - 2]
  const codexSegment = segments[segments.length - 3]
  const documentsSegment = segments[segments.length - 4]
  return (
    documentsSegment === 'Documents' &&
    codexSegment === 'Codex' &&
    date !== undefined &&
    STORAGE_DATE_SEGMENT_RE.test(date) &&
    slug !== undefined &&
    slug !== ''
  )
}

function outputText(payload: Rec): string | undefined {
  if (!Array.isArray(payload.content)) return undefined
  const texts = payload.content
    .filter(isRecord)
    .filter((block) => block.type === 'output_text')
    .map((block) => asString(block.text) ?? '')
    .filter((text) => text !== '')
  return texts.length > 0 ? texts.join('\n') : undefined
}

/**
 * Reads the latest model/effort available in a complete rollout fragment.
 *
 * `turn_context` is normally emitted near the start of a turn. Large turns can
 * push it outside a tail read, so providers use this on the rollout head as a
 * fallback only; tail context remains authoritative for newer turns.
 */
export function parseCodexRolloutContext(text: string): CodexRolloutContext {
  let model: string | undefined
  let effort: string | undefined

  for (const record of jsonlRecords(text)) {
    if (record.type !== 'turn_context') continue
    model = asString(record.payload.model) ?? model
    effort = asString(record.payload.effort) ?? effort
  }

  return { model, effort }
}

/** Extract model/effort, open-turn state and the latest reply from a rollout tail. */
export function parseCodexRolloutTail(tailText: string): CodexRolloutInfo {
  const context = parseCodexRolloutContext(tailText)
  let lastMessage: string | undefined
  let openTurnId: string | null | undefined
  /** Whether a task_complete has been read at all — see completedTurn (#219). */
  let sawTaskComplete = false

  for (const record of jsonlRecords(tailText)) {
    if (record.type === 'response_item') {
      if (record.payload.type === 'message' && record.payload.role === 'assistant') {
        lastMessage = outputText(record.payload) ?? lastMessage
      }
      continue
    }
    if (record.type !== 'event_msg') continue
    switch (record.payload.type) {
      case 'task_started':
        openTurnId = asString(record.payload.turn_id) ?? null
        break
      case 'task_complete': {
        const turnId = asString(record.payload.turn_id)
        // Recorded for every task_complete read, matched or not: a turn whose
        // task_started fell outside this tail still completed, and the record
        // of its ending is exactly this line (#219).
        sawTaskComplete = true
        // Close the open turn when ids match, or when either side has no id.
        if (openTurnId === null || turnId === undefined || turnId === openTurnId) {
          openTurnId = undefined
        }
        lastMessage = asString(record.payload.last_agent_message) ?? lastMessage
        break
      }
      case 'turn_aborted': {
        // The user interrupted the turn (verified real payload shape:
        // {"type":"turn_aborted","turn_id":"…","reason":"interrupted",…}).
        // Structurally this ends the turn exactly like task_complete: without
        // it the unmatched task_started keeps the dwarf mining forever after
        // an Esc, even though the agent sits at the prompt (issue #34).
        const turnId = asString(record.payload.turn_id)
        if (openTurnId === null || turnId === undefined || turnId === openTurnId) {
          openTurnId = undefined
        }
        break
      }
      case 'agent_message':
        lastMessage = asString(record.payload.message) ?? lastMessage
        break
    }
  }

  return {
    ...context,
    busy: openTurnId !== undefined,
    completedTurn: sawTaskComplete && openTurnId === undefined,
    lastMessage
  }
}

/** One `*** Add File:`/`*** Update File:`/`*** Delete File:` line of an apply_patch envelope. */
const PATCH_FILE_ACTION_RE = /^\*\*\* (?:Add File|Update File|Delete File): (.+)$/m

/**
 * The subject `toolActivityLine` needs for one Codex tool call, read out of
 * whichever shape that call's own record carries (#240) — two different
 * shapes for the two tools this app draws a line for.
 *
 * `shell_command` is a `function_call`; its command sits inside `arguments`,
 * which is itself a JSON-encoded STRING rather than an object
 * (`{"command":"...","workdir":"...","timeout_ms":...}`), so it takes a
 * second parse. `apply_patch` is a `custom_tool_call`; its target is the
 * FIRST `*** Add File:`/`*** Update File:`/`*** Delete File:` line of its own
 * `input`, the patch envelope Codex writes rather than a `file_path` field.
 * Every apply_patch call measured on this machine on 2026-09-07 opens with
 * one of those three lines, and 39 of 93 name more than one file — only the
 * first travels, the same call `askedQuestion` makes for a different tool's
 * multi-entry input (see docs/provider-formats.md §2.2).
 */
function codexToolInput(name: string, payload: Rec): Record<string, unknown> | undefined {
  if (name === 'shell_command') {
    const rawArguments = payload.arguments
    if (typeof rawArguments !== 'string') return undefined
    let parsed: unknown
    try {
      parsed = JSON.parse(rawArguments)
    } catch {
      return undefined
    }
    if (!isRecord(parsed) || typeof parsed.command !== 'string') return undefined
    return { command: parsed.command }
  }
  if (name === 'apply_patch') {
    const input = payload.input
    if (typeof input !== 'string') return undefined
    const filePath = PATCH_FILE_ACTION_RE.exec(input)?.[1]
    return filePath === undefined ? undefined : { file_path: filePath }
  }
  return undefined
}

/**
 * The last `limit` human-readable messages of a rollout: user_message events,
 * assistant response_items, and one line per tool call the design's four
 * verbs name (#240), interleaved between them in the order the rollout
 * carried them. agent_message events are skipped because they duplicate the
 * response_item text of the same reply, and so is a tool call
 * `toolActivityLine` names no verb for — `exec`'s 5000-plus calls above all,
 * whose input is a JavaScript program rather than a command line.
 */
export function extractCodexFeed(tailText: string, limit: number): FeedMessage[] {
  const feed: FeedMessage[] = []
  for (const record of jsonlRecords(tailText)) {
    if (record.type === 'event_msg' && record.payload.type === 'user_message') {
      const text = asString(record.payload.message)
      if (text !== undefined) feed.push({ role: 'user', text, timestamp: record.timestamp })
      continue
    }
    if (
      record.type === 'response_item' &&
      record.payload.type === 'message' &&
      record.payload.role === 'assistant'
    ) {
      const text = outputText(record.payload)
      if (text !== undefined) feed.push({ role: 'assistant', text, timestamp: record.timestamp })
      continue
    }
    if (
      record.type !== 'response_item' ||
      (record.payload.type !== 'function_call' && record.payload.type !== 'custom_tool_call')
    ) {
      continue
    }
    const name = asString(record.payload.name)
    if (name === undefined) continue
    const input = codexToolInput(name, record.payload)
    if (input === undefined) continue
    const line = toolActivityLine(name, input)
    if (line !== undefined) feed.push({ ...line, timestamp: record.timestamp })
  }
  return feed.slice(-limit)
}

/** The text of a `response_item` message, whichever way its blocks are typed. */
function messageItemText(payload: Rec): string | undefined {
  if (!Array.isArray(payload.content)) return undefined
  const texts = payload.content
    .filter(isRecord)
    .map((block) => asString(block.text) ?? '')
    .filter((text) => text !== '')
  return texts.length > 0 ? texts.join('\n') : undefined
}

/**
 * The FIRST thing a person said in one rollout, for the launch receipt (#191).
 *
 * Deliberately not `extractCodexFeed(head, …)[0]`. That reading is the panel's
 * — user_message events only, because they are what a human typed and an
 * `agent_message` would duplicate a reply — and it is right for a feed and
 * incomplete for this. A Codex child thread is a FORK: #218 measured that it
 * carries no `event_msg/user_message` at all, and its human prompt survives
 * only as a `response_item` request item. `codex exec`'s own rollout shape has
 * not been read on this machine, so both are accepted rather than betting on
 * the one this app happens to have fixtures for.
 *
 * The event WINS over an item that precedes it, rather than the two racing on
 * position. An event is Codex stating outright that a person sent this; a
 * request item is the model's input, which is the same words for a prompt and
 * is also where a harness-injected context block would appear. Where both
 * exist the stronger evidence decides, and the weaker one is only ever reached
 * for a rollout that carries none.
 *
 * Undefined means this rollout has not recorded a human turn yet — an ordinary
 * state for a thread whose file exists before its first prompt is flushed, and
 * never proof that its session belongs to somebody else.
 */
export function firstCodexUserMessage(text: string): string | undefined {
  let requested: string | undefined
  for (const record of jsonlRecords(text)) {
    if (record.type === 'event_msg' && record.payload.type === 'user_message') {
      const message = asString(record.payload.message)
      if (message !== undefined) return message
      continue
    }
    if (
      requested === undefined &&
      record.type === 'response_item' &&
      record.payload.type === 'message' &&
      record.payload.role === 'user'
    ) {
      requested = messageItemText(record.payload)
    }
  }
  return requested
}
