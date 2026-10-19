// Pure readers of the Antigravity CLI's step log (15 §5 Antigravity row;
// `~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript.jsonl`).
// Every line is one step `{step_index, source, type, status, created_at, content?, thinking?,
// tool_calls?, truncated_fields?}` (docs/provider-formats.md §3.1, measured on agy 1.1.26). No I/O
// and no clock read: the same bytes always give the same facts (HO-37).
//
// - The reader is pinned to agy 1.1.26 (15 §5): a step is readable only when it has an integer
//   `step_index` and one of the five step types that version writes. Anything else, a renamed
//   field, an unknown step type or a line that is not JSON, is `null`: the adapter skips it with a
//   warning, which the loop counts as drift (INV-38, FM-068, FM-086), and reads on. Unknown extra
//   fields on a readable step are ignored (HR T1).
// - Event ids (15 §5): the step's `step_index`. Source keys follow 15 §1.5:
//   `<providerId>:<providerId>:<conversationId>:<eventId>`, with the conversation id whatever
//   session generation the step belongs to: `step_index` is unique across the whole log, so a
//   step keeps the one key it was first written with however it is attributed later.
// - Person lines are `USER_EXPLICIT`/`USER_INPUT` content, read from inside the `<USER_REQUEST>`
//   envelope the CLI wraps the typed words in (the `<ADDITIONAL_METADATA>` and
//   `<USER_SETTINGS_CHANGE>` blocks beside it are the harness's); an unclosed envelope is read whole.
//   Dwarf lines are `MODEL`/`PLANNER_RESPONSE` content. A person line starts a turn; a step with
//   tool calls and a `GENERIC` step (tool output) are a record of work. `SYSTEM_MESSAGE` and
//   `ERROR_MESSAGE` are the harness talking to itself and yield nothing.
// - No turn end: the step log has no end-of-turn record (`turnEnd: 'none'`, C-20), and a step's
//   `status` is written once at append time, so `RUNNING` is no evidence either.
// - No usage: the step log records none (verified on 1.1.26); usage comes from the conversations
//   database (`conversationDb.ts`).
//
// Reimplemented from the candidate `src/main/providers/antigravity/parse.ts` (R16).
import type { FolderPath, Instant, ProviderId } from '../../../../kernel/domain/values'
import type { ConversationEntry } from '../../../suppliers'
import type { ObservedEvent } from '../../ports/observationAdapter'

/** The step types agy 1.1.26 writes (docs/provider-formats.md §3.1). */
export const ANTIGRAVITY_STEP_TYPES: ReadonlySet<string> = new Set([
  'USER_INPUT',
  'PLANNER_RESPONSE',
  'GENERIC',
  'SYSTEM_MESSAGE',
  'ERROR_MESSAGE'
])

/** One readable step, reduced to what the observer uses. */
export interface AntigravityStep {
  stepIndex: number
  source: string
  type: string
  /** The step's `created_at`, or null when it carries no readable time. */
  at: Instant | null
  content: string | null
  /** Whether the model called at least one tool in this step. */
  toolCalls: boolean
}

type Rec = Record<string, unknown>

function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A readable step, or null for a line this pinned reader does not recognise (drift). */
export function parseStepLine(text: string): AntigravityStep | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  const stepIndex = parsed.step_index
  const type = parsed.type
  if (typeof stepIndex !== 'number' || !Number.isInteger(stepIndex) || stepIndex < 0) return null
  if (typeof type !== 'string' || !ANTIGRAVITY_STEP_TYPES.has(type)) return null
  const created = typeof parsed.created_at === 'string' ? Date.parse(parsed.created_at) : NaN
  return {
    stepIndex,
    source: typeof parsed.source === 'string' ? parsed.source : '',
    type,
    at: Number.isFinite(created) ? (created as Instant) : null,
    content: typeof parsed.content === 'string' ? parsed.content : null,
    toolCalls: Array.isArray(parsed.tool_calls) && parsed.tool_calls.length > 0
  }
}

const USER_REQUEST = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/

/** The words a person typed, out of the envelope the CLI wraps them in; whole when unclosed. */
export function userRequestText(content: string): string {
  return (USER_REQUEST.exec(content)?.[1] ?? content).trim()
}

/** The source key of an event of a conversation (15 §1.5; the adapter id is the provider family). */
export function sourceKeyOf(
  providerId: ProviderId,
  conversationId: string,
  eventId: string
): string {
  return `${providerId}:${providerId}:${conversationId}:${eventId}`
}

/** The conversation entry a step is, if any (stateless: window reads use it too). */
export function entryOf(step: AntigravityStep, sourceKey: string): ConversationEntry | null {
  const content = step.content
  if (content === null || content.trim() === '') return null
  if (step.source === 'USER_EXPLICIT' && step.type === 'USER_INPUT') {
    const text = userRequestText(content)
    return text === '' ? null : { sourceKey, role: 'person', text, providerTime: step.at }
  }
  if (step.source === 'MODEL' && step.type === 'PLANNER_RESPONSE') {
    return { sourceKey, role: 'dwarf', text: content.trim(), providerTime: step.at }
  }
  return null
}

export interface StepContext {
  providerId: ProviderId
  /** The conversation the step belongs to: its keys are the conversation's. */
  conversationId: string
  /**
   * The session the step is the dwarf of: the conversation id, or a resumed generation of it
   * (`resumedSessionIdOf`, `AntigravityObservationAdapter.ts`).
   */
  sessionId: string
  /** The conversation's workspace from `history.jsonl`, or null while none names it. */
  cwd: FolderPath | null
  /** The step's byte offset in its log: the first step states the session. */
  offset: number
}

/** The facts one readable step states. */
export function eventsOfStep(step: AntigravityStep, context: StepContext): ObservedEvent[] {
  const identity = { providerId: context.providerId, providerSessionId: context.sessionId }
  const base = { identity, ...(context.cwd === null ? {} : { cwd: context.cwd }) }
  const eventId = String(step.stepIndex)
  const events: ObservedEvent[] = []
  if (context.offset === 0 && context.cwd !== null && step.at !== null) {
    // The log's first step states the conversation's first session.
    events.push({
      ...base,
      kind: 'session',
      sourceEventId: `conversation:${context.conversationId}`,
      cwd: context.cwd,
      at: step.at
    })
  }
  if (step.at !== null) {
    const startsTurn = step.source === 'USER_EXPLICIT' && step.type === 'USER_INPUT'
    const isWork = step.type === 'GENERIC' || (step.type === 'PLANNER_RESPONSE' && step.toolCalls)
    if (startsTurn || isWork) {
      events.push({
        ...base,
        kind: 'activity',
        sourceEventId: eventId,
        at: step.at,
        activity: startsTurn ? 'turn-started' : 'record'
      })
    }
  }
  const entry = entryOf(step, sourceKeyOf(context.providerId, context.conversationId, eventId))
  if (entry !== null)
    events.push({ ...base, kind: 'entries', sourceEventId: eventId, entries: [entry] })
  return events
}
