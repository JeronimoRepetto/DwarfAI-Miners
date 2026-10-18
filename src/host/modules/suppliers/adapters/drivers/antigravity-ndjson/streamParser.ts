// The held-stream reader of the Antigravity `ndjson` driver (15 §4.8): agy's stdout with
// `--output-format stream-json`, one JSON event per line. Pure: no I/O, no clock read; the same
// bytes always give the same records (HO-37, C-19).
//
// The shapes (antigravity.google/docs/cli/headless, read 2026-10-18; measured on agy 1.1.26 in the
// re-homed `fixtures/antigravity/ndjson/1.1.26-synthetic/` lines):
// - `init`, once per process: `conversation_id` (the session's identity, 15 §4.8) and `init`
//   (`cwd`, `tools`, `permission_mode`, and `model` when set);
// - `step_update`: `step_update.{conversation_id, step_index, state (ACTIVE|DONE), step_type
//   (user_input|agent_response|tool|checkpoint), text_delta?, tool_name?, tool_info?}`;
//   `text_delta` is a true delta, accumulated per step and published once at DONE;
// - `result`, once per turn: `result.{conversation_id, status, response?, error?, num_turns,
//   usage}`; its `usage` is cumulative and not read (row A1 usage fidelity U→0, SP-10).
//
// Drift is skipped, never thrown (INV-38): a line that is not JSON, an event or a step type this
// build has no reading for, or a known event whose fields cannot be read is one `drift` record.
// Unknown extra fields are ignored (HR T1). CR before LF is tolerated (HO-37).
//
// Reimplemented from the candidate `src/main/sessionLaunch/antigravityHeldSession.ts`
// (`AntigravityStreamReader`, R16): its delta rule, its once-per-step tool rule and its status
// vocabulary are carried over.
import type { TurnEndKind } from '../../../../../kernel/domain/sharedContracts'

type Rec = Record<string, unknown>

/** One parsed stdout line. */
export type StreamRecord =
  | { readonly kind: 'init'; readonly conversationId: string | null }
  | {
      readonly kind: 'step'
      readonly index: number
      readonly done: boolean
      readonly type: 'user_input' | 'agent_response' | 'tool' | 'checkpoint'
      readonly textDelta: string
      readonly toolName: string | null
      readonly parameters: Readonly<Rec>
    }
  | { readonly kind: 'result'; readonly status: string | null; readonly numTurns: number | null }
  | { readonly kind: 'drift'; readonly detail: string }

/** Splits stdout into lines; a chunk may end mid-line, and CR before LF is dropped. */
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

  /** What is left once the output ended: a last line without its terminator, if any. */
  flush(): string | null {
    const rest = this.pending.replace(/\r$/, '')
    this.pending = ''
    return rest.trim() === '' ? null : rest
  }
}

const STEP_TYPES: ReadonlySet<string> = new Set([
  'user_input',
  'agent_response',
  'tool',
  'checkpoint'
])

export const DRIFT = {
  notJson: 'a line that is not JSON',
  unknownEvent: 'an event this build has no reading for',
  unreadableStep: 'a step this build cannot read',
  unknownStepType: 'a step type this build has no reading for',
  unreadableResult: 'a result this build cannot read'
} as const

function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const nonEmpty = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null

export function parseLine(line: string): StreamRecord {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return { kind: 'drift', detail: DRIFT.notJson }
  }
  if (!isRecord(parsed)) return { kind: 'drift', detail: DRIFT.notJson }
  switch (parsed.event) {
    case 'init':
      return { kind: 'init', conversationId: nonEmpty(parsed.conversation_id) }
    case 'step_update':
      return stepOf(parsed.step_update)
    case 'result': {
      const result = parsed.result
      if (!isRecord(result)) return { kind: 'drift', detail: DRIFT.unreadableResult }
      const turns = result.num_turns
      return {
        kind: 'result',
        status: nonEmpty(result.status),
        numTurns: typeof turns === 'number' && Number.isInteger(turns) && turns > 0 ? turns : null
      }
    }
    default:
      return { kind: 'drift', detail: DRIFT.unknownEvent }
  }
}

function stepOf(step: unknown): StreamRecord {
  if (!isRecord(step)) return { kind: 'drift', detail: DRIFT.unreadableStep }
  const index = step.step_index
  const type = step.step_type
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
    return { kind: 'drift', detail: DRIFT.unreadableStep }
  }
  if (typeof type !== 'string') return { kind: 'drift', detail: DRIFT.unreadableStep }
  if (!STEP_TYPES.has(type)) return { kind: 'drift', detail: DRIFT.unknownStepType }
  const info = step.tool_info
  return {
    kind: 'step',
    index,
    done: step.state === 'DONE',
    type: type as 'user_input' | 'agent_response' | 'tool' | 'checkpoint',
    textDelta: typeof step.text_delta === 'string' ? step.text_delta : '',
    toolName: nonEmpty(step.tool_name) ?? (isRecord(info) ? nonEmpty(info.name) : null),
    parameters: isRecord(info) && isRecord(info.parameters) ? info.parameters : {}
  }
}

/** A provider status word is shown as a detail only when it is one plain upper-case word. */
const STATUS_WORD = /^[A-Z][A-Z_]{0,63}$/

/**
 * ADR-021 item 5 for the documented `result.status` vocabulary: SUCCESS concluded; ERROR and
 * INVALID errored; CANCELED and INTERRUPTED interrupted; WAITING and RUNNING end no turn (null).
 * Any other status ends its turn errored, with the status as detail (C-20).
 */
export function turnEndOf(status: string | null): { kind: TurnEndKind; detail?: string } | null {
  switch (status) {
    case 'SUCCESS':
      return { kind: 'concluded' }
    case 'ERROR':
    case 'INVALID':
      return { kind: 'errored', detail: status }
    case 'CANCELED':
    case 'INTERRUPTED':
      return { kind: 'interrupted', detail: status }
    case 'WAITING':
    case 'RUNNING':
      return null
    default:
      return {
        kind: 'errored',
        detail: status !== null && STATUS_WORD.test(status) ? status : 'an unknown result status'
      }
  }
}

/** The parameter names agy's tools name their subject with (measured on 1.1.26). */
const SUBJECT_FIELDS = [
  'CommandLine',
  'AbsolutePath',
  'TargetFile',
  'DirectoryPath',
  'Query',
  'Pattern',
  'SearchPath',
  'SearchDirectory'
]
const SUMMARY_MAX_CHARS = 200

/** One redacted line for a tool step (ADR-007 item 4): its subject, else its name; never output. */
export function toolSummary(
  toolName: string,
  parameters: Readonly<Rec>,
  redact: (text: string) => string
): string {
  const subject = SUBJECT_FIELDS.map((field) => parameters[field]).find(
    (value): value is string => typeof value === 'string' && value.trim() !== ''
  )
  const line = (subject ?? toolName).replace(/\s+/g, ' ').trim().slice(0, SUMMARY_MAX_CHARS)
  return redact(line)
}
