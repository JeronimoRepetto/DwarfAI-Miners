// Pure readers of Claude Code transcript lines (15 §5 Claude row;
// `projects/<encoded cwd>/<sessionId>.jsonl` and `<sessionId>/subagents/agent-<id>.jsonl`). Every
// record is one JSON object with a string `type` (docs/provider-formats.md §1). No I/O and no clock
// read: the same bytes always give the same facts (HO-37).
//
// - A line that is not such a record is malformed (`null`): the adapter skips it with a warning
//   (INV-38, FM-086). A record of a type this reader does not use (`system`, `summary`,
//   `file-history-snapshot`, …) is not malformed and yields nothing (C-11).
// - Keys (15 §1.5, ADR-006 item 2): `sourceKey = <adapterId>:<providerId>:<sessionId>[:<agentId>]:<eventId>`
//   with `eventId` the record's `uuid` (else `<byteOffset>:<sha1(line)>`, for a record with none),
//   so the bytes around a record (CRLF, unknown fields) never change its key.
// - Identity (ADR-015 item 7): the record's `sessionId` (else the file's), plus the subagent's agent
//   id when the file is a subagent's transcript. The cwd is the record's own: the project-folder
//   name is a lossy encoding of it and is never decoded (ADR-030).
// - Control plane (FM-086, INV-68): a slash command and its output, a meta line, a compaction
//   summary (#188), a "Warmup", a side-chain record in the session's own file and a synthetic
//   assistant message are not conversation: each is an entry flagged `controlPlane` with a label
//   for its text (never the record's own text), so its key is claimed and no row is written.
// - Person lines: a `user` record's text, as a string or as text blocks (#216); a `tool_result`-only
//   record carries none. A message typed mid-turn is the `queued_command` attachment whose origin is
//   `human` (#180). Dwarf lines: an assistant record's text blocks.
// - Usage (ADR-006 items 4 and 6, HR O4): one unit per `message.id`. Claude Code writes one row per
//   content block of a message, each with the usage so far; the first row with a `stop_reason` is
//   the final one and seals the unit, and a message that never gets one is sealed by the next
//   message of the stream. Normalization (L-05): `input_tokens` is already net of cache reads and
//   writes; `output_tokens` includes `output_tokens_details.thinking_tokens` (every recorded row
//   has output ≥ thinking), so `output = output_tokens − thinking_tokens` and `reasoning =
//   thinking_tokens` (UNVERIFIED until SP-06 records a version).
// - Turn ends (ADR-021 items 4 and 5; S-021-1 partial): a terminal `stop_reason` ends the turn,
//   `tool_use` and `pause_turn` continue it, and an unknown value is `errored` with the raw word.
//   Every end is `inferred`: transcript-only Claude declares `turnEnd: 'none'` until S-021-1 passes.
//
// Reimplemented from the candidate `src/main/providers/claude/parse.ts` (R16).
import { createHash } from 'node:crypto'
import type {
  FolderPath,
  Instant,
  ProviderId,
  ProviderIdentity
} from '../../../../kernel/domain/values'
import type {
  ConversationEntry,
  TurnEndedInput,
  TurnEndKind,
  UsageObservationInput
} from '../../../suppliers'
import type { ObservedEvent } from '../../ports/observationAdapter'

type Rec = Record<string, unknown>

/** One transcript record, read but not interpreted. */
export interface ClaudeRecord {
  type: string
  raw: Rec
  /** The record's own time, or null when it carries none. */
  at: Instant | null
}

/** Which transcript a line belongs to, from where Claude Code wrote it. */
export interface TranscriptFile {
  /** The session the file names (`<sessionId>.jsonl`, or the folder above `subagents/`). */
  sessionId: string
  /** The subagent whose transcript this is; null for the session's own file. */
  agentId: string | null
  /** The agent that spawned this subagent, as its sidecar states it; null when none is named. */
  parentAgentId: string | null
}

/** Who wrote the stream, and where its keys live. */
export interface TranscriptContext {
  providerId: ProviderId
  file: TranscriptFile
}

interface OpenUnit {
  messageId: string
  tokens: UsageObservationInput['tokens']
  at: Instant | null
  sealed: boolean
  identity: ProviderIdentity
  cwd: FolderPath | null
  keyBase: string
}

/** What a stream's lines so far leave behind for the next line. */
export interface TranscriptState {
  /** The message whose usage rows are being read. */
  unit: OpenUnit | null
  /** The identities whose `session` fact this stream already gave. */
  announced: readonly string[]
}

/** A stream read from its first byte, or from the middle with nothing known before. */
export const TRANSCRIPT_START: TranscriptState = Object.freeze({ unit: null, announced: [] })

/** What one line adds. */
export interface TranscriptStep {
  state: TranscriptState
  events: ObservedEvent[]
  warnings: string[]
}

/** The labels a control-plane entry carries instead of the record's text. */
export type ControlPlaneLabel =
  'command' | 'meta' | 'compaction' | 'warmup' | 'side-chain' | 'synthetic'

/** Stop reasons after which the same turn goes on (a tool call, a paused server tool). */
const CONTINUATIONS = new Set(['tool_use', 'pause_turn'])

/** ADR-021 item 5 for Claude's stop reasons; an unknown value is `errored` with its word. */
const TURN_END_KINDS: Readonly<Record<string, TurnEndKind>> = {
  end_turn: 'concluded',
  stop_sequence: 'concluded',
  max_tokens: 'capped',
  model_context_window_exceeded: 'capped',
  refusal: 'errored'
}

/** The model name Claude Code writes on a message it made up itself (no API call). */
const SYNTHETIC_MODEL = '<synthetic>'

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
export function parseClaudeLine(text: string): ClaudeRecord | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(parsed) || typeof parsed.type !== 'string' || parsed.type === '') return null
  return { type: parsed.type, raw: parsed, at: instantOf(parsed.timestamp) }
}

/** The deterministic id of a line's record (15 §5): its `uuid`, else offset and line hash. */
export function eventIdOf(record: ClaudeRecord, text: string, offset: number): string {
  const uuid = asString(record.raw.uuid)
  if (uuid !== undefined) return uuid
  return `${offset}:${createHash('sha1').update(text).digest('hex')}`
}

/** The identity a record belongs to: its session, and the file's subagent (ADR-015 item 7). */
export function identityOf(record: ClaudeRecord, context: TranscriptContext): ProviderIdentity {
  const sessionId = asString(record.raw.sessionId) ?? context.file.sessionId
  return {
    providerId: context.providerId,
    providerSessionId: sessionId,
    ...(context.file.agentId === null ? {} : { providerAgentId: context.file.agentId })
  }
}

/** `<providerId>:<sessionId>[:<agentId>]` (15 §1.5). */
function streamKeyOf(identity: ProviderIdentity): string {
  const agent = identity.providerAgentId === undefined ? '' : `:${identity.providerAgentId}`
  return `${identity.providerId}:${identity.providerSessionId}${agent}`
}

/** The source key of an event of `identity` (15 §1.5; the adapter id is the provider family). */
export function sourceKeyOf(identity: ProviderIdentity, eventId: string): string {
  return `${identity.providerId}:${streamKeyOf(identity)}:${eventId}`
}

function identityKeyOf(identity: ProviderIdentity): string {
  return streamKeyOf(identity)
}

/** The text of a message's content: a string, or its text blocks joined (#216). */
function textOf(content: unknown): string | undefined {
  if (typeof content === 'string') return content === '' ? undefined : content
  if (!Array.isArray(content)) return undefined
  const texts = content
    .filter(isRecord)
    .filter((block) => block.type === 'text')
    .map((block) => (typeof block.text === 'string' ? block.text : ''))
    .filter((text) => text !== '')
  return texts.length > 0 ? texts.join('\n') : undefined
}

function messageOf(record: ClaudeRecord): Rec | null {
  return isRecord(record.raw.message) ? record.raw.message : null
}

/** A side-chain record in the session's own file belongs to no conversation of this identity. */
function isForeignSideChain(record: ClaudeRecord, context: TranscriptContext): boolean {
  return record.raw.isSidechain === true && context.file.agentId === null
}

/** What a `user` record's text is: the person's words, or a control-plane label. */
function userLineKind(record: ClaudeRecord, text: string, context: TranscriptContext) {
  const warmup = text.trim() === 'Warmup'
  if (isForeignSideChain(record, context)) return warmup ? 'warmup' : 'side-chain'
  if (record.raw.isCompactSummary === true || record.raw.isVisibleInTranscriptOnly === true) {
    return 'compaction'
  }
  if (record.raw.isSidechain === true && warmup) return 'warmup'
  const opening = text.trimStart()
  if (opening.startsWith('<command-') || opening.startsWith('<local-command-')) return 'command'
  if (record.raw.isMeta === true || opening.startsWith('<')) return 'meta'
  return 'person'
}

/** The prompt of a message typed into a running turn (#180), if the record is one. */
function typedMidTurn(record: ClaudeRecord): string | undefined {
  const attachment = record.raw.attachment
  if (!isRecord(attachment) || attachment.type !== 'queued_command') return undefined
  if (!isRecord(attachment.origin) || attachment.origin.kind !== 'human') return undefined
  const prompt = typeof attachment.prompt === 'string' ? attachment.prompt.trim() : ''
  return prompt === '' ? undefined : prompt
}

/**
 * The conversation entry a record is, if any (stateless: also used by window reads). A
 * control-plane entry carries a label, never the record's text.
 */
export function entryOf(
  record: ClaudeRecord,
  context: TranscriptContext,
  eventId: string
): ConversationEntry | null {
  const identity = identityOf(record, context)
  const common = {
    sourceKey: sourceKeyOf(identity, eventId),
    providerTime: record.at,
    ...(identity.providerAgentId === undefined ? {} : { providerAgentId: identity.providerAgentId })
  }
  const controlPlane = (label: ControlPlaneLabel): ConversationEntry => ({
    ...common,
    role: 'system-line',
    text: label,
    controlPlane: true
  })
  if (record.type === 'user') {
    const text = textOf(messageOf(record)?.content)
    if (text === undefined) return null
    const kind = userLineKind(record, text, context)
    return kind === 'person' ? { ...common, role: 'person', text } : controlPlane(kind)
  }
  if (record.type === 'attachment') {
    const typed = typedMidTurn(record)
    return typed === undefined ? null : { ...common, role: 'person', text: typed }
  }
  if (record.type === 'assistant') {
    const message = messageOf(record)
    const text = textOf(message?.content)
    if (text === undefined) return null
    if (isForeignSideChain(record, context)) return controlPlane('side-chain')
    if (message?.model === SYNTHETIC_MODEL) return controlPlane('synthetic')
    return { ...common, role: 'dwarf', text }
  }
  return null
}

function tokensOf(usage: Rec): UsageObservationInput['tokens'] {
  const details = isRecord(usage.output_tokens_details) ? usage.output_tokens_details : {}
  const output = asCount(usage.output_tokens)
  const thinking = Math.min(asCount(details.thinking_tokens), output)
  return {
    inputNet: asCount(usage.input_tokens),
    output: output - thinking,
    cacheRead: asCount(usage.cache_read_input_tokens),
    cacheWrite: asCount(usage.cache_creation_input_tokens),
    reasoning: thinking
  }
}

function usageEventOf(unit: OpenUnit): ObservedEvent {
  const usage: UsageObservationInput = {
    sourceKey: `${unit.keyBase}:${unit.messageId}`,
    unitKey: unit.messageId,
    fidelity: 1,
    tokens: unit.tokens,
    sealed: true,
    providerTime: unit.at
  }
  return {
    identity: unit.identity,
    ...(unit.cwd === null ? {} : { cwd: unit.cwd }),
    kind: 'usage',
    sourceEventId: unit.messageId,
    usage
  }
}

/** The end of the turn a stop reason says, or null for none (a partial row, a continuation). */
function turnEndOf(stopReason: unknown): Pick<TurnEndedInput, 'kind' | 'detail'> | null {
  if (typeof stopReason !== 'string' || stopReason === '' || CONTINUATIONS.has(stopReason)) {
    return null
  }
  const kind = TURN_END_KINDS[stopReason] ?? 'errored'
  return kind === 'errored' ? { kind, detail: stopReason } : { kind }
}

/**
 * One line of a stream, in order: its facts and the state the next line starts from. `offset` is
 * the line's byte offset in its file and `text` its bytes without the line ending.
 */
export function stepTranscript(
  state: TranscriptState,
  record: ClaudeRecord,
  line: { text: string; offset: number },
  context: TranscriptContext
): TranscriptStep {
  const eventId = eventIdOf(record, line.text, line.offset)
  const identity = identityOf(record, context)
  const cwd = (asString(record.raw.cwd) as FolderPath | undefined) ?? null
  const base = { identity, ...(cwd === null ? {} : { cwd }) }
  const events: ObservedEvent[] = []
  const warnings: string[] = []
  let unit = state.unit
  let announced = state.announced
  const foreign = isForeignSideChain(record, context)

  const identityKey = identityKeyOf(identity)
  if (!foreign && cwd !== null && record.at !== null && !announced.includes(identityKey)) {
    announced = [...announced, identityKey]
    const parentIdentity: ProviderIdentity | undefined =
      identity.providerAgentId === undefined
        ? undefined
        : {
            providerId: identity.providerId,
            providerSessionId: identity.providerSessionId,
            ...(context.file.parentAgentId === null
              ? {}
              : { providerAgentId: context.file.parentAgentId })
          }
    events.push({
      identity,
      kind: 'session',
      sourceEventId: eventId,
      cwd,
      at: record.at,
      ...(parentIdentity === undefined ? {} : { parentIdentity })
    })
  }

  const entry = entryOf(record, context, eventId)
  if (entry?.role === 'person' && record.type === 'user' && record.at !== null) {
    events.push({
      ...base,
      kind: 'activity',
      sourceEventId: eventId,
      at: record.at,
      activity: 'turn-started'
    })
  }

  const message = messageOf(record)
  const counted =
    record.type === 'assistant' && message !== null && !foreign && message.model !== SYNTHETIC_MODEL
  if (counted && record.at !== null) {
    events.push({
      ...base,
      kind: 'activity',
      sourceEventId: eventId,
      at: record.at,
      activity: 'record'
    })
  }
  if (entry !== null)
    events.push({ ...base, kind: 'entries', sourceEventId: eventId, entries: [entry] })

  if (counted) {
    const messageId = asString(message.id)
    const usage = message.usage
    if (messageId !== undefined && isRecord(usage)) {
      // A later message seals the one before it if no row of it carried a stop reason.
      if (unit !== null && unit.messageId !== messageId && !unit.sealed) {
        events.push(usageEventOf(unit))
      }
      if (unit === null || unit.messageId !== messageId) {
        unit = {
          messageId,
          tokens: tokensOf(usage),
          at: record.at,
          sealed: false,
          identity,
          cwd,
          keyBase: `${identity.providerId}:${streamKeyOf(identity)}`
        }
      } else if (!unit.sealed) {
        unit = { ...unit, tokens: tokensOf(usage), at: record.at }
      }
      // The first row with a stop reason is the message's final one (ADR-006 item 6).
      if (!unit.sealed && typeof message.stop_reason === 'string' && message.stop_reason !== '') {
        events.push(usageEventOf(unit))
        unit = { ...unit, sealed: true }
      }
    }

    const end = turnEndOf(message.stop_reason)
    if (end !== null) {
      if (record.at === null) {
        warnings.push(`turn end without a time at byte ${line.offset}`)
      } else {
        events.push({
          ...base,
          kind: 'turn-ended',
          sourceEventId: eventId,
          at: record.at,
          end: {
            turnKey: sourceKeyOf(identity, eventId),
            ...end,
            at: record.at,
            reliability: 'inferred',
            cancelledFromApp: false
          }
        })
      }
    }
  }

  return { state: { unit, announced }, events, warnings }
}
