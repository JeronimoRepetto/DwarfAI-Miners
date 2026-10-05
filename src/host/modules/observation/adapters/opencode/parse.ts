// Pure readers of OpenCode's `message.data` and `part.data` JSON blobs (15 §5 OpenCode row;
// docs/opencode-format.md Row 3, measured on 1.18.31). No I/O and no clock read: the same row always
// gives the same facts (HO-37).
//
// - A message is `{ role, time: { created, completed? }, tokens?, finish?, … }`. `role` and
//   `time.created` are required; anything else missing degrades to absent. `parentID` is the user
//   message an assistant message answers (a reply edge), never topology: only `session.parent_id`
//   is (Row 4), so it is not read at all.
// - An assistant message is finished once `time.completed` is set; until then its parts are still
//   being written and nothing of it is observed.
// - Usage (ADR-006 item 4; Row 14): `tokens { input, output, reasoning, cache { read, write } }` of
//   the finished assistant message, one unit per message. `input` already excludes the cache and
//   `output` excludes reasoning (an 8-message session summed to 135 530 input against 224 512
//   cache read, and to 90 output against 149 reasoning), so they map to `inputNet` and `output`
//   as written. The `tokens` of each `step-finish` part repeat the message's own, per step: they
//   are never read, or a two-step reply would be counted twice.
// - Parts: `text` is the words; `reasoning`, `tool`, `step-start`, `step-finish` and any type this
//   reader does not use are no entry and no warning (C-11). A part that is not a JSON object with a
//   string `type`, or a `text` part without text, is malformed: skipped with a warning (INV-38).
//
// Reimplemented from the candidate `src/main/providers/opencode/parse.ts` (R16).
import type { FolderPath, Instant } from '../../../../kernel/domain/values'
import type { UsageObservationInput } from '../../../suppliers'

type Rec = Record<string, unknown>

/** The token counters of one usage unit (ADR-006 item 4). */
export type UsageTokens = UsageObservationInput['tokens']

/** One message, as far as observation reads it. */
export interface OpenCodeMessage {
  role: 'user' | 'assistant'
  /** When an assistant message finished; null while it streams (always null for a user one). */
  completedAt: Instant | null
  /** The assistant message's own tokens; null when it carries none. */
  tokens: UsageTokens | null
}

/** One part, as far as observation reads it. */
export type OpenCodePart = { type: 'text'; text: string } | { type: 'other' }

function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** A token counter: a finite, non-negative whole number, else 0. */
function asCount(value: unknown): number {
  const n = asNumber(value)
  return n === undefined || n < 0 ? 0 : Math.trunc(n)
}

/** A `data` column as a record: the raw TEXT parsed, or null when it is not a JSON object. */
function recordOf(raw: unknown): Rec | null {
  if (typeof raw !== 'string') return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function tokensOf(value: unknown): UsageTokens | null {
  if (!isRecord(value)) return null
  const cache = isRecord(value['cache']) ? value['cache'] : {}
  return {
    inputNet: asCount(value['input']),
    output: asCount(value['output']),
    cacheRead: asCount(cache['read']),
    cacheWrite: asCount(cache['write']),
    reasoning: asCount(value['reasoning'])
  }
}

/** `message.data` → the message, or null when this build cannot read it. */
export function parseMessageData(raw: unknown): OpenCodeMessage | null {
  const data = recordOf(raw)
  if (data === null) return null
  const role = data['role']
  if (role !== 'user' && role !== 'assistant') return null
  const time = isRecord(data['time']) ? data['time'] : {}
  if (asNumber(time['created']) === undefined) return null
  if (role === 'user') return { role, completedAt: null, tokens: null }
  return {
    role,
    completedAt: asNumber(time['completed']) ?? null,
    tokens: tokensOf(data['tokens'])
  }
}

/** `part.data` → the part, or null when it is malformed. */
export function parsePartData(raw: unknown): OpenCodePart | null {
  const data = recordOf(raw)
  if (data === null || typeof data['type'] !== 'string') return null
  if (data['type'] !== 'text') return { type: 'other' }
  const text = data['text']
  return typeof text === 'string' ? { type: 'text', text } : null
}

/** Whether a unit spent anything: a reply that ended before the model answered spent nothing. */
export function spentAnything(tokens: UsageTokens): boolean {
  return Object.values(tokens).some((n) => n > 0)
}

/**
 * `session.directory` in its native spelling: OpenCode writes a Windows folder with forward
 * slashes (`C:/Users/…`, Row 3), which the other adapters' records spell with backslashes. Decided
 * by the value's own shape, never by the host OS (skill `platform-ports`).
 */
export function nativeDirectory(directory: string): FolderPath {
  return (
    /^[A-Za-z]:\//.test(directory) ? directory.replaceAll('/', '\\') : directory
  ) as FolderPath
}
