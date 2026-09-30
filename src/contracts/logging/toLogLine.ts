import { LOG_RECORD_FIELDS, logRecordSchema, type LogRecord } from './logRecord'
import { redactStack, redactText } from './redact'

export type LogLineRefusal = { refused: 'sensitive' | 'field-not-allowed' }

const ALLOWED_KEYS: ReadonlySet<PropertyKey> = new Set(LOG_RECORD_FIELDS)

/**
 * One log line for `r` (ADR-026 items 3–5), or a refusal and no line.
 *
 * 1. Allowlist: a key that is not a `LogRecord` field → `field-not-allowed`.
 * 2. Every value must have its declared shape (the strict schema: types, unions, owner-declared UUIDv7 ids, ISO-8601
 *    UTC `ts`). A value that does not — a structured payload, content in an id field — is treated as a
 *    payload that must not be written → `sensitive`.
 * 3. `msg` and `errCode` go through `redactText`, `stack` through `redactStack`.
 * 4. One JSON object in `LogRecord` field order, ending in a single `\n` on every OS.
 */
export function toLogLine(r: LogRecord): string | LogLineRefusal {
  if (typeof r !== 'object' || r === null || Array.isArray(r)) return { refused: 'sensitive' }
  if (Reflect.ownKeys(r).some((key) => !ALLOWED_KEYS.has(key))) {
    return { refused: 'field-not-allowed' }
  }
  const parsed = logRecordSchema.safeParse(r)
  if (!parsed.success) return { refused: 'sensitive' }

  const line: Record<string, unknown> = {}
  for (const field of LOG_RECORD_FIELDS) {
    const value = parsed.data[field]
    if (value === undefined) continue
    if (field === 'msg' || field === 'errCode') line[field] = redactText(value as string)
    else if (field === 'stack') line[field] = redactStack(value as string)
    else line[field] = value
  }
  return `${JSON.stringify(line)}\n`
}
