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
 * The last `limit` messages of a transcript window.
 *
 * Only two record shapes are a message, and both are named by their SOURCE as
 * well as their type, because the type alone is not proof of who spoke:
 *
 * - `USER_EXPLICIT`/`USER_INPUT` with string content — a human turn.
 * - `MODEL`/`PLANNER_RESPONSE` with string content — the reply the panel draws.
 *
 * Everything else is skipped, and each omission is a fact rather than a gap.
 * `GENERIC` is tool output and is most of the file's bytes. A
 * `PLANNER_RESPONSE` carrying only `tool_calls` is the model acting, not
 * speaking. `thinking` is a field of its own, so no tag-stripping heuristic is
 * needed anywhere here — which is the one thing this format makes easier than
 * the others. `SYSTEM_MESSAGE` and `ERROR_MESSAGE` are the harness talking to
 * itself, and drawing either as a turn would attribute it to a person.
 *
 * No issuer is ever stamped (see MessageIssuer): absent means the human, and
 * this store records no evidence that a turn came from anywhere else.
 *
 * **No activity line for a `tool_calls` entry (#240) — a decision, not an
 * oversight.** Claude and Codex each publish one; this format was measured
 * the same way and left out on purpose. Real corpus, this machine,
 * 2026-09-07: 180 `tool_calls` across 3 conversations (`view_file` 93,
 * `run_command` 33, `list_dir` 20, `manage_subagents` 14, `grep_search` 11,
 * `find_by_name` 4, and five others under 3 each). Every subject field
 * observed (`AbsolutePath`, `CommandLine`, `Query`, ...) is a DOUBLE-encoded
 * string — the value itself opens with a literal `"`, i.e. a JSON string
 * whose content is another JSON string, confirmed on all 105 sampled
 * occurrences of the three most common tools — so reading one honestly would
 * add a decode step this format is the only one of the three that needs. Two
 * things kept that from being worth it here: the corpus is three
 * conversations on one machine against Claude's ~38 000 blocks and Codex's
 * ~1 000, and `docs/provider-formats.md` already carries this format under
 * "no compatibility promise, and it has already changed across CLI versions"
 * — `run_command`'s own args gained `CommandLine` between the fixture capture
 * and this measurement. A future implementer has the field mapping above to
 * start from; this change stops at documenting it.
 */
export function extractAntigravityFeed(text: string, limit: number): FeedMessage[] {
  const feed: FeedMessage[] = []
  for (const step of antigravityTranscriptSteps(text)) {
    const message = spokenMessage(step)
    if (message !== undefined) feed.push(message)
  }
  return feed.slice(-limit)
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
