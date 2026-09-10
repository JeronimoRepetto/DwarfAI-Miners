import { toolActivityLine } from '../../domain/permissionSummary'
import { trimFeed } from '../feedWindow'
import type { FeedMessage } from '../../domain/types'

/**
 * Pure parsers for the Antigravity CLI's own step log
 * (`~/.gemini/antigravity-cli/brain/<conversation-id>/.system_generated/logs/transcript.jsonl`).
 *
 * Every line is one STEP of the conversation:
 * `{step_index, source, type, status, created_at, content?, thinking?, tool_calls?, truncated_fields?}`
 * — see docs/provider-formats.md §3, read live off Antigravity CLI 1.1.26.
 *
 * This is a private format with no compatibility promise, and it has already
 * changed across CLI versions. So nothing here treats a shape as guaranteed:
 * an unknown `type`, a missing field, a half-written final line and a record
 * that is not JSON at all are all SKIPPED, never thrown on. A throw here would
 * ride the 2-second poll and take the whole tick with it — the same fail-safe
 * rule the process probe is under.
 */

/**
 * One tool call the model made in a step, raw — see `antigravityToolInput`
 * for what turns `args` into a subject the shared activity table can read.
 */
export interface AntigravityToolCall {
  name: string
  args: Record<string, unknown>
}

/** One step of the log, reduced to the fields this app reads. */
export interface AntigravityStep {
  stepIndex: number
  /** `USER_EXPLICIT`, `MODEL` or `SYSTEM` on 1.1.26 — open, and read as such. */
  source: string
  /** `USER_INPUT`, `PLANNER_RESPONSE`, `GENERIC`, `SYSTEM_MESSAGE`, `ERROR_MESSAGE` on 1.1.26. */
  type: string
  /** `DONE` or `RUNNING` on 1.1.26. Written once, when the step is appended. */
  status: string
  /** Epoch ms of `created_at`, absent when it could not be read as a date. */
  createdAtMs?: number
  /** The record's own `created_at` string, verbatim — what a feed message carries. */
  createdAt: string
  /** Displayable text, present only on some record types. */
  content?: string
  /** Tool calls the model made in this step, present only where the CLI wrote some. */
  toolCalls?: AntigravityToolCall[]
}

/**
 * What one bounded tail read of a transcript establishes.
 *
 * Deliberately not a busy/idle verdict: freshness needs a clock, and a parser
 * that took one would be answering a question the provider owns. This reports
 * what the file SAYS and leaves how old it is to the caller.
 */
export interface AntigravityTranscriptState {
  /**
   * The newest step in the window, and whether it was still running when it
   * was written.
   *
   * The newest one and no other, because `status` is a snapshot at append time
   * and is never rewritten — verified on 1.1.26, where a `RUNNING` background
   * task step was followed by fourteen more `DONE` steps and still reads
   * `RUNNING` today. "Any running step in the window" would therefore report a
   * turn that closed minutes ago, and a crashed one forever.
   */
  latestStep?: {
    stepIndex: number
    running: boolean
    /** Absent when the record carried no readable clock — never defaulted to now. */
    createdAtMs?: number
  }
  /** The last thing the planner said as text, for the speech bubble. */
  lastMessage?: string
}

const RUNNING_STATUS = 'RUNNING'
const USER_SOURCE = 'USER_EXPLICIT'
const USER_TYPE = 'USER_INPUT'
const MODEL_SOURCE = 'MODEL'
const PLANNER_TYPE = 'PLANNER_RESPONSE'

type Rec = Record<string, unknown>

function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * The `tool_calls` of one step, or undefined when the field is absent or not
 * an array. A call missing a string `name` or a record `args` is dropped on
 * its own rather than refusing the whole array — the same per-item leniency
 * `askedQuestion`/`calledTool` take on Claude's side.
 */
function asToolCalls(value: unknown): AntigravityToolCall[] | undefined {
  if (!Array.isArray(value)) return undefined
  const calls: AntigravityToolCall[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const name = asString(item.name)
    if (name === undefined || !isRecord(item.args)) continue
    calls.push({ name, args: item.args })
  }
  return calls
}

/**
 * Every step a window yields, oldest first, de-duplicated by `step_index`.
 *
 * `step_index` is the log's own identity for a step and ascends across the
 * file — with gaps, which are ordinary (81 → 83 in one real capture) and mean
 * nothing here. Sorting on it rather than trusting file order is what makes
 * the de-duplication meaningful: where one index appears twice the LATER line
 * wins, because a rewritten record is the CLI correcting itself.
 *
 * A line that is not an object, carries no numeric `step_index`, or names no
 * string `type` is dropped. That covers the two things a bounded byte read
 * does routinely — open mid-line and end mid-line — as well as a future
 * version's record this build has no reading for.
 */
export function antigravityTranscriptSteps(text: string): AntigravityStep[] {
  const byIndex = new Map<number, AntigravityStep>()
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (!isRecord(parsed)) continue
    const stepIndex = parsed.step_index
    const type = asString(parsed.type)
    if (typeof stepIndex !== 'number' || !Number.isFinite(stepIndex) || type === undefined) continue
    const createdAt = asString(parsed.created_at) ?? ''
    const createdAtMs = Date.parse(createdAt)
    const step: AntigravityStep = {
      stepIndex,
      source: asString(parsed.source) ?? '',
      type,
      status: asString(parsed.status) ?? '',
      createdAt
    }
    if (Number.isFinite(createdAtMs)) step.createdAtMs = createdAtMs
    const content = asString(parsed.content)
    if (content !== undefined) step.content = content
    const toolCalls = asToolCalls(parsed.tool_calls)
    if (toolCalls !== undefined && toolCalls.length > 0) step.toolCalls = toolCalls
    byIndex.set(stepIndex, step)
  }
  return [...byIndex.values()].sort((left, right) => left.stepIndex - right.stepIndex)
}

const USER_REQUEST_RE = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/

/**
 * The words a person actually typed, out of the envelope the CLI wraps them in.
 *
 * A `USER_INPUT` record's `content` is not a prompt: it is the prompt inside a
 * `<USER_REQUEST>` block, followed by blocks the harness wrote and the person
 * never saw — `<ADDITIONAL_METADATA>` with the local time, and
 * `<USER_SETTINGS_CHANGE>` narrating a model switch (both observed on 1.1.26).
 * Showing the envelope would draw the CLI's own bookkeeping in the panel under
 * the user's face.
 *
 * This is structural, not a prose heuristic: the block is a fixed delimiter
 * pair the CLI writes, and where the pair is absent or unclosed the content is
 * returned WHOLE rather than guessed at. Reading nothing would be worse than
 * reading too much — a prompt is the one thing the panel can be sure a human
 * said.
 */
export function antigravityUserRequestText(content: string): string {
  const match = USER_REQUEST_RE.exec(content)
  return (match?.[1] ?? content).trim()
}

/** The text of a step that is somebody speaking, or undefined for every other step. */
function spokenMessage(step: AntigravityStep): FeedMessage | undefined {
  const content = step.content
  if (content === undefined || content.trim() === '') return undefined
  if (step.source === USER_SOURCE && step.type === USER_TYPE) {
    return { role: 'user', text: antigravityUserRequestText(content), timestamp: step.createdAt }
  }
  if (step.source === MODEL_SOURCE && step.type === PLANNER_TYPE) {
    return { role: 'assistant', text: content.trim(), timestamp: step.createdAt }
  }
  return undefined
}

/**
 * One `args` field of an Antigravity tool call, decoded TWICE (#280).
 *
 * Every subject field this CLI writes is a JSON string whose own content is
 * ANOTHER JSON string — confirmed on 105 sampled occurrences across the three
 * most common tools, docs/provider-formats.md §3.1.2 — so the outer parse
 * that already ran once over the whole record leaves this value still
 * needing a second `JSON.parse`. Only a string result counts, matching every
 * other subject reader in this codebase.
 *
 * This is also where a truncated field answers itself. The CLI cuts a long
 * value mid-string and appends a `<truncated N bytes>` marker in place of the
 * closing quote — and the raw newline inside that cut is itself an illegal
 * control character inside a JSON string literal — so the second parse
 * throws on precisely the calls this app must not draw a line for. No
 * special-casing needed: malformed JSON already says "no line" honestly.
 */
function antigravityDecodedSubject(value: unknown): string | undefined {
  const once = asString(value)
  if (once === undefined) return undefined
  let twice: unknown
  try {
    twice = JSON.parse(once)
  } catch {
    return undefined
  }
  return typeof twice === 'string' ? twice : undefined
}

/**
 * The subject `toolActivityLine` needs for one Antigravity tool call, mapped
 * from the CLI's own arg names to the shared table's canonical fields (#280)
 * — `command`, `file_path`, `pattern`, `path`, see permissionSummary.ts.
 *
 * Only the tools whose subject is a path, a command or a pattern are named
 * here, matching `TOOL_ACTIVITY_KINDS`'s rows for this CLI exactly — every
 * other observed tool (`manage_subagents`, `schedule`, `invoke_subagent`,
 * `call_mcp_tool`) is deliberately absent, and that table's own comment gives
 * the reason for each by kind.
 *
 * `grep_search` and `find_by_name` can carry both a pattern and a path — the
 * same shape Claude's own Grep tool carries — so both are read and the
 * shared table's own priority (pattern ahead of path) settles which one
 * names the call.
 *
 * `list_dir` reads as `read` rather than a fifth verb: the design names four,
 * and browsing a directory's contents is closer to reading them than to any
 * of the other three.
 *
 * AMENDED for #237, step 5: the `read` parameter, and it is the whole of the
 * change — every tool, field and priority decision above is #280's, untouched.
 * This CLI reports the same tool call TWO ways, and only the decoding differs
 * between them. In its private transcript each `args` value is a JSON string
 * needing a second parse (see `antigravityDecodedSubject`); on its official
 * stream-json output `tool_info.parameters` carries plain values. The arg
 * NAMES are identical either way, so the mapping is shared and each reader
 * brings its own decoder — one table of names, which is what stops a held
 * session and an observed one drawing the same call differently.
 */
export function antigravityToolSubject(
  name: string,
  read: (key: string) => string | undefined
): Record<string, unknown> | undefined {
  switch (name) {
    case 'view_file':
    case 'write_to_file':
    case 'replace_file_content': {
      const filePath = read(name === 'view_file' ? 'AbsolutePath' : 'TargetFile')
      return filePath === undefined ? undefined : { file_path: filePath }
    }
    case 'list_dir': {
      const path = read('DirectoryPath')
      return path === undefined ? undefined : { path }
    }
    case 'run_command': {
      const command = read('CommandLine')
      return command === undefined ? undefined : { command }
    }
    case 'grep_search':
    case 'find_by_name': {
      const pattern = read(name === 'grep_search' ? 'Query' : 'Pattern')
      const path = read(name === 'grep_search' ? 'SearchPath' : 'SearchDirectory')
      if (pattern === undefined && path === undefined) return undefined
      return {
        ...(pattern === undefined ? {} : { pattern }),
        ...(path === undefined ? {} : { path })
      }
    }
    default:
      return undefined
  }
}

/**
 * That mapping over a TRANSCRIPT's args, which are double-encoded (#280) —
 * the reader `toolCallActivity` below uses, and the one this function existed
 * as in full before #237 split the name table out of it.
 */
function antigravityToolInput(name: string, args: Rec): Record<string, unknown> | undefined {
  return antigravityToolSubject(name, (key) => antigravityDecodedSubject(args[key]))
}

/**
 * The activity lines one step's tool calls publish, in call order — empty
 * for a step with no `tool_calls`, or where none of them named a subject
 * this app can show (#280).
 */
function toolCallActivity(step: AntigravityStep): FeedMessage[] {
  if (step.toolCalls === undefined) return []
  const entries: FeedMessage[] = []
  for (const call of step.toolCalls) {
    const input = antigravityToolInput(call.name, call.args)
    if (input === undefined) continue
    const activity = toolActivityLine(call.name, input)
    if (activity !== undefined) entries.push({ ...activity, timestamp: step.createdAt })
  }
  return entries
}

/**
 * The last `limit` things SAID in a transcript window, with the tool calls
 * between them carried — `limit` counts the texts and never the activity
 * lines (`trimFeed`, #359), the same rule the other two extractors trim by.
 *
 * Only two record shapes are a message, and both are named by their SOURCE as
 * well as their type, because the type alone is not proof of who spoke:
 *
 * - `USER_EXPLICIT`/`USER_INPUT` with string content — a human turn.
 * - `MODEL`/`PLANNER_RESPONSE` with string content — the reply the panel draws.
 *
 * `GENERIC` is tool output and is most of the file's bytes; `thinking` is a
 * field of its own, so no tag-stripping heuristic is needed anywhere here —
 * the one thing this format makes easier than the others. `SYSTEM_MESSAGE`
 * and `ERROR_MESSAGE` are the harness talking to itself, and drawing either
 * as a turn would attribute it to a person.
 *
 * No issuer is ever stamped (see MessageIssuer): absent means the human, and
 * this store records no evidence that a turn came from anywhere else.
 *
 * **One line per tool call (#280), off the same shared rule #240 draws for
 * Claude and Codex.** A `PLANNER_RESPONSE` carrying `tool_calls` is the model
 * acting rather than speaking, and each call this app recognises — a path, a
 * command or a pattern, per `TOOL_ACTIVITY_KINDS`'s Antigravity rows — gets
 * its own `Edited`/`Ran`/`Read`/`Searched` line, in call order, decoded twice
 * through `antigravityToolInput`/`antigravityDecodedSubject` above. A call
 * this table has never mapped, and a call whose subject the CLI's own
 * truncation cut through, both publish NOTHING — see those functions' own
 * comments, and docs/provider-formats.md §3.1.6 for the measured counts.
 */
export function extractAntigravityFeed(text: string, limit: number): FeedMessage[] {
  const feed: FeedMessage[] = []
  for (const step of antigravityTranscriptSteps(text)) {
    const message = spokenMessage(step)
    if (message !== undefined) feed.push(message)
    feed.push(...toolCallActivity(step))
  }
  return trimFeed(feed, limit)
}

/**
 * What the tail of one transcript establishes about the session right now.
 *
 * `lastMessage` is the newest planner reply with text in the window, which is
 * the same reading `extractAntigravityFeed` takes — one rule for what counts
 * as the agent speaking, so a bubble and a feed can never disagree.
 */
export function parseAntigravityTranscriptTail(text: string): AntigravityTranscriptState {
  const steps = antigravityTranscriptSteps(text)
  const state: AntigravityTranscriptState = {}
  const newest = steps[steps.length - 1]
  if (newest !== undefined) {
    state.latestStep = {
      stepIndex: newest.stepIndex,
      running: newest.status === RUNNING_STATUS,
      ...(newest.createdAtMs === undefined ? {} : { createdAtMs: newest.createdAtMs })
    }
  }
  for (const step of steps) {
    const message = spokenMessage(step)
    if (message?.role === 'assistant') state.lastMessage = message.text
  }
  return state
}
