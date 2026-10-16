// The reader of `claude -p --output-format stream-json` stdout (15 §4.2): line-framed JSON, CRLF
// tolerant, reassembled across any chunking, and skip-not-throw on drift (15 §1.2
// `protocol-drift`, HO-33): a line that is not JSON, a JSON value that is not a record and a
// record of an unknown type become a `drift` value the session reports and skips. Pure: no I/O,
// no clock read, so the same bytes always give the same records (C-19).
//
// Record shapes read (Claude Code stream-json, recorded on 2.1.301 by ISSUE-321): `system` (its
// `init` subtype is readiness, S-020-1; `hook_started`, `hook_response`, `notification`,
// `permission_denied`, `thinking_tokens` and any later subtype carry nothing this driver
// reports), `assistant` (message.id, content blocks, usage, stop_reason, parent_tool_use_id,
// error), `user` (tool_result blocks), `result` (subtype, is_error), and `rate_limit_event`
// (rate_limit_info.status, resetsAt). Known records this driver does not use (partial-message
// stream events, control frames, keep-alives) are `ignored`, not drift.
//
// Candidate decision (21 §6) for the pure parts: `src/main/sessionLaunch/claudeTurnOutcome.ts` is
// adapted, not kept: its subtype mapping is the same reading of Claude's `result` record, but it
// imports the Agent SDK's types (R11, OQ-52) and maps `error_max_budget_usd` to capped, which
// ADR-021 item 5 does not (only `error_max_turns` is capped; every other `error_*` is errored).
// The tool-summary subject list follows `src/main/domain/permissionSummary.ts` (copied, R16),
// without its UI verbs (copy belongs to the renderer) and without its JSON fallback, which could
// carry tool input into a summary (ADR-007 item 4). Usage tokens follow the observation adapter's
// Claude reading (`observation/adapters/claude/parse.ts` `tokensOf`), so both paths count alike.
import type { TurnEndKind, UsageObservation } from '../../../../../kernel/domain/sharedContracts'

type Rec = Record<string, unknown>

/** One content block of an assistant record that this driver reads. */
export type AssistantBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool_use'; readonly id: string; readonly name: string; readonly input: Rec }

export type StreamRecord =
  | { readonly kind: 'system'; readonly subtype: string; readonly sessionId: string | null }
  | {
      readonly kind: 'assistant'
      readonly uuid: string | null
      readonly parentToolUseId: string | null
      readonly messageId: string | null
      readonly model: string | null
      readonly stopReason: string | null
      readonly usage: Rec | null
      readonly blocks: readonly AssistantBlock[]
      readonly error: string | null
    }
  | {
      readonly kind: 'user'
      readonly parentToolUseId: string | null
      readonly toolResults: readonly { readonly toolUseId: string; readonly isError: boolean }[]
    }
  | {
      readonly kind: 'result'
      readonly uuid: string | null
      readonly subtype: string
      readonly isError: boolean
    }
  | {
      readonly kind: 'rate-limit'
      readonly status: string | null
      readonly resetsAt: number | null
    }
  | { readonly kind: 'ignored' }
  | { readonly kind: 'drift'; readonly detail: string }

/** Records Claude Code writes that carry nothing this driver reports. */
const IGNORED_TYPES = new Set([
  'stream_event',
  'control_request',
  'control_response',
  'control_cancel_request',
  'keep_alive'
])

/** A record type is echoed into a drift detail only when it looks like one (no free text). */
const TYPE_NAME = /^[a-z][a-z0-9_]{0,63}$/

/** Splits a byte stream into lines, whatever the chunking; `\r\n` and `\n` both end a line. */
export class LineFramer {
  private pending = ''

  push(chunk: string): string[] {
    this.pending += chunk
    const lines: string[] = []
    let newline = this.pending.indexOf('\n')
    while (newline !== -1) {
      const line = this.pending.slice(0, newline).replace(/\r$/, '')
      this.pending = this.pending.slice(newline + 1)
      if (line.trim() !== '') lines.push(line)
      newline = this.pending.indexOf('\n')
    }
    return lines
  }

  /** What is left once the stream ended: a last line without its terminator, if any. */
  flush(): string | null {
    const rest = this.pending.replace(/\r$/, '')
    this.pending = ''
    return rest.trim() === '' ? null : rest
  }
}

function isRecord(value: unknown): value is Rec {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null)

function blocksOf(content: unknown): AssistantBlock[] {
  if (!Array.isArray(content)) return []
  return content.filter(isRecord).flatMap((block): AssistantBlock[] => {
    if (block.type === 'text' && typeof block.text === 'string') {
      return [{ type: 'text', text: block.text }]
    }
    if (block.type === 'tool_use' && typeof block.id === 'string') {
      return [
        {
          type: 'tool_use',
          id: block.id,
          name: str(block.name) ?? '',
          input: isRecord(block.input) ? block.input : {}
        }
      ]
    }
    return [] // thinking and any later block kind: nothing this driver reports
  })
}

function toolResultsOf(content: unknown): { toolUseId: string; isError: boolean }[] {
  if (!Array.isArray(content)) return []
  return content
    .filter(isRecord)
    .filter((block) => block.type === 'tool_result' && typeof block.tool_use_id === 'string')
    .map((block) => ({ toolUseId: block.tool_use_id as string, isError: block.is_error === true }))
}

/** One stdout line as a record, or why it is drift. Never throws. */
export function parseLine(line: string): StreamRecord {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return { kind: 'drift', detail: 'a line that is not JSON' }
  }
  if (!isRecord(value) || typeof value.type !== 'string') {
    return { kind: 'drift', detail: 'a line that is not a record' }
  }
  const parent = str(value.parent_tool_use_id)
  switch (value.type) {
    case 'system':
      return { kind: 'system', subtype: str(value.subtype) ?? '', sessionId: str(value.session_id) }
    case 'assistant': {
      const message = isRecord(value.message) ? value.message : {}
      return {
        kind: 'assistant',
        uuid: str(value.uuid),
        parentToolUseId: parent,
        messageId: str(message.id),
        model: str(message.model),
        stopReason: str(message.stop_reason),
        usage: isRecord(message.usage) ? message.usage : null,
        blocks: blocksOf(message.content),
        error: str(value.error)
      }
    }
    case 'user': {
      const message = isRecord(value.message) ? value.message : {}
      return { kind: 'user', parentToolUseId: parent, toolResults: toolResultsOf(message.content) }
    }
    case 'result':
      return {
        kind: 'result',
        uuid: str(value.uuid),
        subtype: str(value.subtype) ?? '',
        isError: value.is_error === true
      }
    case 'rate_limit_event': {
      const info = isRecord(value.rate_limit_info) ? value.rate_limit_info : {}
      const resetsAt = typeof info.resetsAt === 'number' ? info.resetsAt : null
      return { kind: 'rate-limit', status: str(info.status), resetsAt }
    }
    default:
      if (IGNORED_TYPES.has(value.type)) return { kind: 'ignored' }
      return {
        kind: 'drift',
        detail: TYPE_NAME.test(value.type)
          ? `a record of unknown type ${value.type}`
          : 'a record of an unreadable type'
      }
  }
}

/**
 * ADR-021 item 5: Claude result subtypes `success` → concluded, `error_max_turns` → capped, any
 * other subtype → errored. Every end but `success` carries the provider's own word as `detail`.
 */
export function turnEndOf(subtype: string): { kind: TurnEndKind; detail?: string } {
  if (subtype === 'success') return { kind: 'concluded' }
  const word = subtype === '' ? 'result without a subtype' : subtype
  return { kind: subtype === 'error_max_turns' ? 'capped' : 'errored', detail: word }
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/** ADR-006 item 4 tokens of one assistant usage record; thinking tokens are reasoning. */
export function tokensOf(usage: Rec): UsageObservation['tokens'] {
  const details = isRecord(usage.output_tokens_details) ? usage.output_tokens_details : {}
  const output = count(usage.output_tokens)
  const thinking = Math.min(count(details.thinking_tokens), output)
  return {
    inputNet: count(usage.input_tokens),
    output: output - thinking,
    cacheRead: count(usage.cache_read_input_tokens),
    cacheWrite: count(usage.cache_creation_input_tokens),
    reasoning: thinking
  }
}

/** The input fields that name a tool call's subject, first present wins (#240, `description` last). */
const SUBJECT_FIELDS = ['command', 'file_path', 'pattern', 'path', 'url', 'description'] as const
/** A summary is one line, capped before redaction (`permissionSummary.ts` rule). */
export const SUMMARY_MAX_CHARS = 240

/** One redacted line naming a tool call's subject, or its tool name; never tool input as JSON. */
export function toolSummary(
  toolName: string,
  input: Rec,
  redact: (text: string) => string
): string {
  const subject = SUBJECT_FIELDS.map((field) => input[field]).find(
    (value): value is string => typeof value === 'string' && value.trim() !== ''
  )
  const line = (subject ?? toolName).replace(/\s+/g, ' ').trim().slice(0, SUMMARY_MAX_CHARS)
  return redact(line)
}
