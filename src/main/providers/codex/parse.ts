import { toolActivityLine } from '../../domain/permissionSummary'
import { trimFeed } from '../feedWindow'
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
  /**
   * The one question this rollout is waiting on an answer to, when it carries
   * one — see parseCodexPendingQuestion. Absent is the ordinary case, and it
   * claims nothing: an approval prompt leaves no record at all, so absence
   * here never means "not blocked" (docs/codex-v2-format.md §9).
   */
  pendingQuestion?: CodexPendingQuestion
}

/** One answer a Codex question offered, in the model's own words. */
export interface CodexQuestionOption {
  label: string
  description?: string
}

/**
 * A `request_user_input` call nothing in this tail has answered — the ONE
 * record Codex writes that proves a session is waiting on its human (#265).
 *
 * Mirrors ClaudePendingQuestion field for field, because it feeds the same
 * DwarfQuestion and the panel must not be able to tell which CLI asked. The
 * `call_id` plays the toolUseId's role for the same reason it does there:
 * "answered" is exact rather than inferred, because the reply arrives later as
 * a `function_call_output` naming the same id.
 */
export interface CodexPendingQuestion {
  toolUseId: string
  question: string
  header?: string
  /**
   * Always false. Codex's own argument shape carries no multi-select field —
   * three real calls were measured and none had one (docs/codex-v2-format.md
   * §9(c)) — and a default of true would make the panel offer a gesture the
   * agent never said it would accept. Kept as a field rather than dropped so
   * this type stays assignable to the shared one.
   */
  multiSelect: boolean
  options: CodexQuestionOption[]
  /** The asking record's own timestamp, when it carried one. */
  askedAt?: string
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

  // Walked separately rather than folded into the switch above, because it
  // reads `response_item` call/output pairs across the whole tail while that
  // loop reads `event_msg` turn boundaries. One pass could do both and would
  // tie two unrelated readings to one another's control flow.
  const pendingQuestion = parseCodexPendingQuestion(tailText)

  return {
    ...context,
    busy: openTurnId !== undefined,
    completedTurn: sawTaskComplete && openTurnId === undefined,
    lastMessage,
    ...(pendingQuestion === undefined ? {} : { pendingQuestion })
  }
}

/** The tool name Codex's model calls to put a question to the person. */
const REQUEST_USER_INPUT = 'request_user_input'

/** One entry of `arguments.questions`, once the double parse has run. */
function codexQuestionFrom(
  raw: unknown
): { question: string; header?: string; options: CodexQuestionOption[] } | undefined {
  if (!isRecord(raw)) return undefined
  const question = asString(raw.question)
  if (question === undefined || question === '') return undefined
  const header = asString(raw.header)
  const options = (Array.isArray(raw.options) ? raw.options : [])
    .filter(isRecord)
    .flatMap((option) => {
      const label = asString(option.label)
      if (label === undefined || label === '') return []
      const description = asString(option.description)
      return [{ label, ...(description === undefined ? {} : { description }) }]
    })
  return { question, ...(header === undefined ? {} : { header }), options }
}

/**
 * The unanswered `request_user_input` call in this tail, or undefined (#265).
 *
 * This is the only "waiting on a human" record Codex writes, and it is the
 * model's own tool call rather than anything this app inferred: an APPROVAL
 * prompt writes nothing at all while it waits, so it is deliberately not
 * looked for here (the measurement is docs/codex-v2-format.md §9).
 *
 * What makes an unanswered call a real observation rather than an artefact of
 * reading a file mid-write: a call line is appended when the call is EMITTED,
 * not batched with its result. Measured — one call in 7 198 across the whole
 * corpus has no output, and its file continues for 234 more records (§9(b)).
 *
 * Two shapes to know. `arguments` is a JSON-encoded STRING, so it takes the
 * same second parse `shell_command` needs. And the answer arrives as a
 * `function_call_output` naming the same `call_id`, which is what makes
 * "answered" exact: a call whose id has been output is gone from the map
 * before the end of the walk, so a tail that contains both is not pending.
 *
 * With several open, the LAST is the one reported — the same rule the Claude
 * transcript parse follows, and for the same reason: it is the one the person
 * is looking at. Within one call, only `questions[0]` travels; a call asking
 * more than one thing at once was never observed, and folding several into one
 * card would attribute options to a question that did not offer them.
 *
 * Reading a bounded tail is safe in the one direction that matters: an output
 * always follows its call, so a call outside the window cannot be reported as
 * pending, and a window can only ever miss a question — never invent one.
 */
export function parseCodexPendingQuestion(tailText: string): CodexPendingQuestion | undefined {
  const open = new Map<string, CodexPendingQuestion>()
  for (const record of jsonlRecords(tailText)) {
    if (record.type !== 'response_item') continue
    const payload = record.payload
    const callId = asString(payload.call_id)
    if (callId === undefined) continue
    if (payload.type === 'function_call_output') {
      open.delete(callId)
      continue
    }
    if (payload.type !== 'function_call' || payload.name !== REQUEST_USER_INPUT) continue
    const rawArguments = payload.arguments
    if (typeof rawArguments !== 'string') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(rawArguments)
    } catch {
      continue
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.questions)) continue
    const first = codexQuestionFrom(parsed.questions[0])
    if (first === undefined) continue
    open.set(callId, {
      toolUseId: callId,
      question: first.question,
      ...(first.header === undefined ? {} : { header: first.header }),
      multiSelect: false,
      options: first.options,
      ...(record.timestamp === '' ? {} : { askedAt: record.timestamp })
    })
  }
  return [...open.values()].pop()
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
 * The last `limit` things SAID in a rollout: user_message events,
 * assistant response_items, and one line per tool call the design's four
 * verbs name (#240), interleaved between them in the order the rollout
 * carried them. agent_message events are skipped because they duplicate the
 * response_item text of the same reply, and so is a tool call
 * `toolActivityLine` names no verb for — `exec`'s 5000-plus calls above all,
 * whose input is a JavaScript program rather than a command line.
 *
 * `limit` counts the texts and never the activity lines (`trimFeed`, #359),
 * the same rule the Claude and Antigravity extractors trim by.
 *
 * `activityLimit` is forwarded rather than defaulted so a PAGE read can ask for
 * the window whole (#364); see `FeedExtractor`.
 */
export function extractCodexFeed(
  tailText: string,
  limit: number,
  activityLimit?: number
): FeedMessage[] {
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
  return trimFeed(feed, limit, activityLimit)
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
