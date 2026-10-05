// Pure readers of Codex rollout lines (15 §5 Codex row; `~/.codex/sessions/**/rollout-*.jsonl`).
// Every record is `{ timestamp, type, payload }` (docs/provider-formats.md §2, measured on 0.145
// through 0.153.4). No I/O and no clock read: the same bytes always give the same facts (HO-37).
//
// - A line that is not such a record is malformed (`null`): the adapter skips it with a warning
//   (INV-38, FM-086). A record of a type this reader does not use (`world_state`, `compacted`, …)
//   is not malformed and yields nothing (C-11).
// - Event ids (15 §5): the record's item id (`payload.id`), else `<byteOffset>:<sha1(line)>`.
// - Turns: `task_started` opens one; `task_complete` (concluded) and `turn_aborted` (interrupted;
//   any other abort reason is `errored` with the raw word, ADR-021 item 5) end it, both reliable
//   (ADR-021 item 4 table, row "Codex observed (rollout)"; #219, #34).
// - Usage (ADR-006 item 4, HR O4): `token_count.info.total_token_usage` is the stream's lifetime
//   total. A turn's unit (`unitKey` = turn id) is the last total inside the turn minus the total
//   before it started, sealed by its end record or by the next `task_started` (ADR-006 item 6).
//   Normalization (L-05): `input_tokens` includes `cached_input_tokens` and `output_tokens`
//   includes `reasoning_output_tokens` (`total_tokens = input_tokens + output_tokens` in every
//   recorded line), so `inputNet = input − cached` and `output = output − reasoning`;
//   `cache_write_input_tokens` (always 0 where recorded) is taken as reported, outside `input`
//   (UNVERIFIED).
// - Person lines (#458): from `event_msg/user_message`, except in a `codex exec` rollout
//   (`session_meta.source = "exec"`), which writes no such event; there the person's words are the
//   user items that are not context injected by the harness. Dwarf lines are assistant items;
//   `agent_message` repeats them and is skipped.
//
// Reimplemented from the candidate `src/main/providers/codex/parse.ts` and `state.ts` (R16).
import { createHash } from 'node:crypto'
import type {
  FolderPath,
  Instant,
  ProviderId,
  ProviderIdentity
} from '../../../../kernel/domain/values'
import type { ConversationEntry, TurnEndedInput, UsageObservationInput } from '../../../suppliers'
import type { ObservedEvent } from '../../ports/observationAdapter'

type Rec = Record<string, unknown>

/** One rollout record, read but not interpreted. */
export interface CodexRecord {
  type: string
  payload: Rec
  /** The record's own time, or null when it carries none. */
  at: Instant | null
}

/** What a rollout's `session_meta` (its first line) says about the session. */
export interface RolloutHead {
  threadId: string
  cwd: FolderPath | null
  at: Instant | null
  parentThreadId: string | null
  /** A headless `codex exec` run: its person lines are user items, not events (#458). */
  exec: boolean
}

/** A lifetime counter as `token_count` reports it. */
export interface TokenTotals {
  input: number
  cached: number
  cacheWrite: number
  output: number
  reasoning: number
}

const ZERO: TokenTotals = { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 }

interface OpenTurn {
  id: string | null
  /** The lifetime total when the turn started; null when that lies outside what was read. */
  baseline: TokenTotals | null
  latest: TokenTotals | null
  latestAt: Instant | null
}

/** What a stream's lines so far leave behind for the next line. */
export interface RolloutState {
  /** The last lifetime total read; null when the stream was not read from its start. */
  total: TokenTotals | null
  turn: OpenTurn | null
}

/** A stream read from its first byte: nothing spent yet. */
export const ROLLOUT_START: RolloutState = Object.freeze({ total: ZERO, turn: null })

/** A stream read from the middle (a gated read or a restart past the look-back): totals unknown. */
export const ROLLOUT_GAP: RolloutState = Object.freeze({ total: null, turn: null })

/** Who wrote the stream and where its keys live. */
export interface RolloutContext {
  providerId: ProviderId
  streamId: string
  head: RolloutHead
}

/** What one line adds. */
export interface RolloutStep {
  state: RolloutState
  events: ObservedEvent[]
  warnings: string[]
}

function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function instantOf(value: unknown): Instant | null {
  if (typeof value !== 'string') return null
  const at = Date.parse(value)
  return Number.isFinite(at) ? at : null
}

/** One line as a record, or null when it is not one (malformed, FM-086). */
export function parseRolloutLine(text: string): CodexRecord | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(parsed) || typeof parsed.type !== 'string' || !isRecord(parsed.payload)) {
    return null
  }
  return { type: parsed.type, payload: parsed.payload, at: instantOf(parsed.timestamp) }
}

/** The deterministic id of a line's record (15 §5): its item id, else offset and line hash. */
export function eventIdOf(record: CodexRecord, text: string, offset: number): string {
  const id = asString(record.payload.id)
  if (id !== undefined) return id
  return `${offset}:${createHash('sha1').update(text).digest('hex')}`
}

/**
 * `threads.cwd` and some Windows paths carry the extended-length prefix (`\\?\C:\…`) a rollout's
 * cwd does not; without stripping it one folder would be two mines. A UNC path keeps its `\\`.
 */
export function normalizeCodexCwd(cwd: string): string {
  if (cwd.startsWith('\\\\?\\UNC\\')) return `\\\\${cwd.slice(8)}`
  if (cwd.startsWith('\\\\?\\')) return cwd.slice(4)
  return cwd
}

/** The parent thread a sub-agent spawn names, from `source` (a tag, or the spawn object). */
export function parentThreadOf(source: unknown): string | null {
  let value = source
  if (typeof value === 'string') {
    if (!value.startsWith('{')) return null
    try {
      value = JSON.parse(value)
    } catch {
      return null
    }
  }
  if (!isRecord(value) || !isRecord(value.subagent)) return null
  const spawn = value.subagent.thread_spawn
  return isRecord(spawn) ? (asString(spawn.parent_thread_id) ?? null) : null
}

/** The head of a rollout from its `session_meta` record, or null for any other record. */
export function rolloutHeadOf(record: CodexRecord): RolloutHead | null {
  if (record.type !== 'session_meta') return null
  const threadId = asString(record.payload.id) ?? asString(record.payload.session_id)
  if (threadId === undefined) return null
  const cwd = asString(record.payload.cwd)
  return {
    threadId,
    cwd: cwd === undefined ? null : (normalizeCodexCwd(cwd) as FolderPath),
    at: instantOf(record.payload.timestamp) ?? record.at,
    parentThreadId: parentThreadOf(record.payload.source),
    exec: record.payload.source === 'exec'
  }
}

/** The `content_item_kinds` prefix of a person's own words on a user item (#458). */
const USER_CONTENT_KIND_PREFIX = 'user.'

/** Tags that open a user item injected by the harness, for builds that write no metadata. */
const INJECTED_CONTEXT_TAGS: readonly string[] = [
  '<recommended_plugins>',
  '<environment_context>',
  '<realtime_delegation>',
  '<codex_delegation>',
  '<user_shell_command>',
  '<turn_aborted>'
]

function itemText(payload: Rec, blockType?: string): string | undefined {
  if (!Array.isArray(payload.content)) return undefined
  const texts = payload.content
    .filter(isRecord)
    .filter((block) => blockType === undefined || block.type === blockType)
    .map((block) => asString(block.text) ?? '')
    .filter((text) => text !== '')
  return texts.length > 0 ? texts.join('\n') : undefined
}

function isInjectedContext(payload: Rec): boolean {
  const passthrough = payload.internal_chat_message_metadata_passthrough
  const kinds = isRecord(passthrough) ? passthrough.content_item_kinds : undefined
  if (Array.isArray(kinds)) {
    return !kinds.some((k) => typeof k === 'string' && k.startsWith(USER_CONTENT_KIND_PREFIX))
  }
  const firstLine = (itemText(payload) ?? '').trimStart().split('\n', 1)[0] ?? ''
  return INJECTED_CONTEXT_TAGS.some((tag) => firstLine.startsWith(tag))
}

/** The conversation entry a record is, if any (stateless: also used by window reads). */
export function entryOf(
  record: CodexRecord,
  head: Pick<RolloutHead, 'exec'>,
  sourceKey: string
): ConversationEntry | null {
  let role: ConversationEntry['role'] | null = null
  let text: string | undefined
  if (record.type === 'event_msg' && record.payload.type === 'user_message' && !head.exec) {
    role = 'person'
    text = asString(record.payload.message)
  } else if (record.type === 'response_item' && record.payload.type === 'message') {
    if (record.payload.role === 'assistant') {
      role = 'dwarf'
      text = itemText(record.payload, 'output_text')
    } else if (record.payload.role === 'user' && head.exec && !isInjectedContext(record.payload)) {
      role = 'person'
      text = itemText(record.payload)
    }
  }
  if (role === null || text === undefined) return null
  return { sourceKey, role, text, providerTime: record.at }
}

/** Response items that are work in a turn (a step of the dwarf), not words. */
const ACTIVITY_ITEMS = new Set([
  'reasoning',
  'function_call',
  'function_call_output',
  'custom_tool_call',
  'custom_tool_call_output',
  'local_shell_call',
  'web_search_call'
])

function totalsOf(payload: Rec): TokenTotals | null {
  const info = payload.info
  if (!isRecord(info) || !isRecord(info.total_token_usage)) return null
  const t = info.total_token_usage
  return {
    input: asCount(t.input_tokens),
    cached: asCount(t.cached_input_tokens),
    cacheWrite: asCount(t.cache_write_input_tokens),
    output: asCount(t.output_tokens),
    reasoning: asCount(t.reasoning_output_tokens)
  }
}

/** `latest − baseline` per counter, or null when a counter went down (a reset, not usage). */
function difference(latest: TokenTotals, baseline: TokenTotals): TokenTotals | null {
  const d: TokenTotals = {
    input: latest.input - baseline.input,
    cached: latest.cached - baseline.cached,
    cacheWrite: latest.cacheWrite - baseline.cacheWrite,
    output: latest.output - baseline.output,
    reasoning: latest.reasoning - baseline.reasoning
  }
  return Object.values(d).some((n) => n < 0) ? null : d
}

/** The ADR-021 kind of a `turn_aborted` reason (item 5: an unknown word is `errored`). */
function abortedKind(reason: string | undefined): Pick<TurnEndedInput, 'kind' | 'detail'> {
  if (reason === undefined || reason === 'interrupted') return { kind: 'interrupted' }
  return { kind: 'errored', detail: reason }
}

/**
 * One line of a stream, in order: its facts and the state the next line starts from. `offset` is
 * the line's byte offset in its file and `text` its bytes without the line ending.
 */
export function stepRollout(
  state: RolloutState,
  record: CodexRecord,
  line: { text: string; offset: number },
  context: RolloutContext
): RolloutStep {
  const { providerId, streamId, head } = context
  const eventId = eventIdOf(record, line.text, line.offset)
  const keyOf = (id: string) => `${providerId}:${streamId}:${id}`
  const identity: ProviderIdentity = { providerId, providerSessionId: head.threadId }
  const base = { identity, ...(head.cwd === null ? {} : { cwd: head.cwd }) }
  const events: ObservedEvent[] = []
  const warnings: string[] = []
  let next: RolloutState = state

  /** Seals the open turn's unit, if it spent anything since it started. */
  const seal = (sealingId: string): void => {
    const turn = next.turn
    if (turn === null || turn.id === null || turn.latest === null) return
    if (turn.baseline === null) {
      warnings.push(`usage of a turn begun before the read window at byte ${line.offset}`)
      return
    }
    const d = difference(turn.latest, turn.baseline)
    if (d === null) {
      warnings.push(`lifetime usage went down at byte ${line.offset}`)
      return
    }
    if (Object.values(d).every((n) => n === 0)) return
    const usage: UsageObservationInput = {
      sourceKey: keyOf(`${sealingId}:usage`),
      unitKey: turn.id,
      fidelity: 1,
      tokens: {
        inputNet: Math.max(0, d.input - d.cached),
        output: Math.max(0, d.output - d.reasoning),
        cacheRead: d.cached,
        cacheWrite: d.cacheWrite,
        reasoning: d.reasoning
      },
      sealed: true,
      providerTime: turn.latestAt
    }
    events.push({ ...base, kind: 'usage', sourceEventId: `${sealingId}:usage`, usage })
  }

  switch (record.type) {
    case 'session_meta': {
      // Only the stream's own head: a forked rollout can carry a copy of another thread's.
      const own = rolloutHeadOf(record)
      if (own !== null && own.threadId === head.threadId && own.cwd !== null && own.at !== null) {
        events.push({
          identity,
          kind: 'session',
          sourceEventId: eventId,
          cwd: own.cwd,
          at: own.at,
          ...(own.parentThreadId === null
            ? {}
            : { parentIdentity: { providerId, providerSessionId: own.parentThreadId } })
        })
      }
      break
    }
    case 'event_msg': {
      const type = record.payload.type
      if (type === 'task_started') {
        seal(eventId)
        next = {
          total: next.total,
          turn: {
            id: asString(record.payload.turn_id) ?? null,
            baseline: next.total,
            latest: null,
            latestAt: null
          }
        }
        if (record.at !== null) {
          events.push({
            ...base,
            kind: 'activity',
            sourceEventId: eventId,
            at: record.at,
            activity: 'turn-started'
          })
        }
      } else if (type === 'token_count') {
        const total = totalsOf(record.payload)
        if (total !== null) {
          next = {
            total,
            turn: next.turn === null ? null : { ...next.turn, latest: total, latestAt: record.at }
          }
        }
      } else if (type === 'task_complete' || type === 'turn_aborted') {
        const turnId = asString(record.payload.turn_id)
        const open = next.turn
        const matches =
          open !== null && (open.id === null || turnId === undefined || open.id === turnId)
        if (matches) seal(eventId)
        const outcome =
          type === 'task_complete'
            ? { kind: 'concluded' as const }
            : abortedKind(asString(record.payload.reason))
        if (record.at === null) {
          warnings.push(`turn end without a time at byte ${line.offset}`)
        } else {
          events.push({
            ...base,
            kind: 'turn-ended',
            sourceEventId: eventId,
            at: record.at,
            end: {
              turnKey: turnId ?? (matches ? open?.id : undefined) ?? keyOf(eventId),
              ...outcome,
              at: record.at,
              reliability: 'reliable',
              cancelledFromApp: false
            }
          })
        }
        if (matches) next = { total: next.total, turn: null }
      }
      break
    }
    case 'response_item': {
      const itemType = record.payload.type
      if (typeof itemType === 'string' && ACTIVITY_ITEMS.has(itemType) && record.at !== null) {
        events.push({
          ...base,
          kind: 'activity',
          sourceEventId: eventId,
          at: record.at,
          activity: 'record'
        })
      }
      break
    }
  }

  const entry = entryOf(record, head, keyOf(eventId))
  if (entry !== null)
    events.push({ ...base, kind: 'entries', sourceEventId: eventId, entries: [entry] })
  return { state: next, events, warnings }
}

/** The thread id a rollout file name carries (`rollout-<time>-<thread id>.jsonl`), if any. */
export function threadIdOfRolloutName(name: string): string | null {
  const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(name)
  return match?.[1] ?? null
}
