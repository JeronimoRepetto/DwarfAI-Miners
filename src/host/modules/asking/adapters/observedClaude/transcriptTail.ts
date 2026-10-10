// The observed-Claude transcript tail (ADR-012 item 3: "the session's latest trusted state (hook
// event + transcript tail)"): which tool call of the main session is still waiting on an answer,
// read from Claude Code's own JSONL records, never from prose. Provider-specific by design (R12:
// `asking/adapters/**`).
//
// - A `tool_use` block of an `assistant` record is a call; a `tool_result` block of a `user` record
//   with its `tool_use_id` resolves it (Claude Code writes one for an Allow and for a Deny alike).
// - Only main-session records count: a subagent's (`isSidechain: true`) call is never matched, so
//   its dialog gets no key (fail closed).
// - The open call is the ONE unresolved call (of the hook's tool, when the hook named one). Two or
//   more are `ambiguous` and match nothing: a key is never pressed on a dialog this cannot name.
// - `version` is the Claude Code version the newest record carries (the key map's pin, keyMap.ts).
// - A bounded tail may start mid-record; that line, and any other line that is not a JSON object,
//   is skipped. CRLF and fields this reader does not know read exactly like their plain twin.
// - The request text is legacy `domain/permissionSummary.ts`'s rule (05 §3.7 "Domain ←
//   domain/permissionSummary.ts"): the first string of `command`, `file_path`, `pattern`, `path`,
//   `url`, else the input as JSON; capped at 240 characters. Its secrets are redacted by the
//   registry's injected `redact` (permissionPromptRegistry.ts) before it leaves for an ask: an
//   adapter never imports `contracts` (05 R9), so the one redaction rule is bound by the wiring.
// - `AskUserQuestion` is Claude Code's question tool: such a call is a question, which this channel
//   never answers by keys (ADR-012 item 5).
import type { FileSystem } from '../../../../kernel/ports/fileSystem'

/** The bounded tail read before each check (ADR-006 item 3: tails are bounded). */
export const TRANSCRIPT_TAIL_BYTES = 262_144

/** The cap on a request's text (legacy `PERMISSION_INPUT_MAX_CHARS`). */
const REQUEST_TEXT_MAX_CHARS = 240

/** The input fields that name a call's subject, first present wins. */
const SUBJECT_FIELDS = ['command', 'file_path', 'pattern', 'path', 'url'] as const

/** Claude Code's question tool (ADR-012 item 5). */
const QUESTION_TOOL = 'AskUserQuestion'

/** A main-session tool call still waiting on an answer. */
export interface PendingCall {
  /** Claude Code's `tool_use` id: the ask's `providerRequestId`. */
  readonly id: string
  readonly toolName: string
  readonly requestText: string
  readonly kind: 'permission' | 'question'
}

/** What one read of the tail shows. */
export interface TailReading {
  /** The Claude Code version of the newest record that carries one. */
  readonly version: string | null
  /** More than one call could be the open one: none is named. */
  readonly ambiguous: boolean
  readonly pending: PendingCall | null
}

/** The fresh read of a transcript's tail (the double: FakeTranscriptTail). */
export interface TranscriptTail {
  /** The tail's text, or null when it cannot be read; never a throw. */
  read(path: string): Promise<string | null>
}

/** The open call of `text`; `toolName`, the hook's, narrows the candidates. */
export function readTail(text: string, toolName?: string): TailReading {
  let version: string | null = null
  const calls = new Map<string, PendingCall>()
  const resolved = new Set<string>()
  for (const line of text.split(/\r?\n/)) {
    const record = parseRecord(line)
    if (record === null) continue
    if (typeof record.version === 'string') version = record.version
    if (record.isSidechain === true) continue
    for (const block of contentOf(record)) {
      if (record.type === 'assistant' && block.type === 'tool_use') {
        const call = callOf(block)
        if (call !== null) calls.set(call.id, call)
      } else if (record.type === 'user' && block.type === 'tool_result') {
        if (typeof block.tool_use_id === 'string') resolved.add(block.tool_use_id)
      }
    }
  }
  const open = [...calls.values()].filter(
    (call) => !resolved.has(call.id) && (toolName === undefined || call.toolName === toolName)
  )
  if (open.length > 1) return { version, ambiguous: true, pending: null }
  return { version, ambiguous: false, pending: open[0] ?? null }
}

/** Whether `text` holds the main session's `tool_result` for the call `id`. */
export function isResolved(text: string, id: string): boolean {
  for (const line of text.split(/\r?\n/)) {
    const record = parseRecord(line)
    if (record === null || record.isSidechain === true || record.type !== 'user') continue
    if (contentOf(record).some((b) => b.type === 'tool_result' && b.tool_use_id === id)) {
      return true
    }
  }
  return false
}

type JsonObject = Record<string, unknown>

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseRecord(line: string): JsonObject | null {
  if (line.trim() === '') return null
  try {
    const value: unknown = JSON.parse(line)
    return isObject(value) ? value : null
  } catch {
    return null
  }
}

function contentOf(record: JsonObject): JsonObject[] {
  const message = record.message
  if (!isObject(message) || !Array.isArray(message.content)) return []
  return message.content.filter(isObject)
}

function callOf(block: JsonObject): PendingCall | null {
  if (typeof block.id !== 'string' || typeof block.name !== 'string') return null
  const input = isObject(block.input) ? block.input : {}
  return {
    id: block.id,
    toolName: block.name,
    requestText: requestTextOf(input),
    kind: block.name === QUESTION_TOOL ? 'question' : 'permission'
  }
}

function requestTextOf(input: JsonObject): string {
  const subject =
    SUBJECT_FIELDS.map((field) => input[field]).find(
      (value): value is string => typeof value === 'string'
    ) ?? JSON.stringify(input)
  return subject.slice(0, REQUEST_TEXT_MAX_CHARS)
}

/** The real tail, over the kernel `FileSystem`'s bounded tail read. */
export class FsTranscriptTail implements TranscriptTail {
  constructor(private readonly fs: Pick<FileSystem, 'readTextTail'>) {}

  async read(path: string): Promise<string | null> {
    try {
      return await this.fs.readTextTail(path, TRANSCRIPT_TAIL_BYTES)
    } catch {
      return null
    }
  }
}
