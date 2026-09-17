import { toolActivityLine } from '../../domain/permissionSummary'
import type { FeedMessage } from '../../domain/types'

/**
 * Pure parsers over OpenCode's `message.data` / `part.data` JSON blobs and
 * `session.model` [V row 3, docs/opencode-format.md]. Mirrors
 * `codex/parse.ts`'s shape: nothing here touches a filesystem or a database,
 * so every case is proved on a fixture alone. Redaction is NOT applied here —
 * that is the provider boundary's job (`opencodeProvider.ts`'s `feed`), so a
 * cursor built from a redacted row still matches these same rows in the same
 * order.
 */

type Rec = Record<string, unknown>

function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * `data` as a record, whichever shape it arrives in.
 *
 * `state.ts` hands over the raw `TEXT` column unparsed — `JSON.parse` stays
 * inside this module, behind this one `try/catch`, so a poll tick never
 * throws on a row this build cannot read (D2's "Thrown poll tick: Never").
 * A caller that already holds a parsed object (every test in this file) is
 * accepted as-is, so a fixture read with `JSON.parse` up front still works.
 */
function parseJsonRecord(data: unknown): Rec | null {
  if (isRecord(data)) return data
  if (typeof data !== 'string') return null
  try {
    const parsed: unknown = JSON.parse(data)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * One `message` row's `data` blob, parsed [V row 3].
 *
 * `message.data.parentID` is deliberately NOT modelled: it is the id of the
 * USER message an assistant message answers — a reply edge inside one
 * conversation — and must never reach `Dwarf.parentId`. Only
 * `session.parent_id` (read in `state.ts`) is topology.
 */
export interface OpenCodeMessage {
  role: 'user' | 'assistant'
  timeCreatedMs: number
  /** Assistant only; ABSENT while the message is still streaming. */
  timeCompletedMs?: number
  /** Assistant only. `'tool-calls'` is an intermediate step; `'stop'` ends the turn. */
  finish?: string
  agent?: string
}

/**
 * `message.data` → its typed record, or `null` for a shape this build did not
 * write. `role` is the one required discriminant; every other field is read
 * defensively, so an OpenCode build that adds a key costs nothing and one
 * that omits an expected key degrades to that field being absent rather than
 * throwing mid-scan.
 */
export function parseOpenCodeMessageData(rawData: unknown): OpenCodeMessage | null {
  const data = parseJsonRecord(rawData)
  if (data === null) return null
  const role = data.role
  if (role !== 'user' && role !== 'assistant') return null

  const time = isRecord(data.time) ? data.time : undefined
  const timeCreatedMs = asNumber(time?.created)
  if (timeCreatedMs === undefined) return null

  const message: OpenCodeMessage = { role, timeCreatedMs }
  const agent = asString(data.agent)
  if (agent !== undefined) message.agent = agent

  if (role === 'assistant') {
    const timeCompletedMs = asNumber(time?.completed)
    if (timeCompletedMs !== undefined) message.timeCompletedMs = timeCompletedMs
    const finish = asString(data.finish)
    if (finish !== undefined) message.finish = finish
  }

  return message
}

/** What `session.model`'s own JSON string names, once the id has been read. */
export interface OpenCodeModel {
  id: string
}

/**
 * `session.model` is a JSON string `{id, providerID}` [V row 3]; a delegated
 * child's carries an extra `variant` key [V row 4], which is read past and
 * ignored — this app names a model by its id alone, exactly as
 * `parseCodexRolloutContext`'s `model` field does.
 */
export function parseOpenCodeModel(raw: string): OpenCodeModel | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  const id = asString(parsed.id)
  return id === undefined ? null : { id }
}

/**
 * One `part` row's `data` blob, parsed [V row 3]. `reasoning` carries no
 * displayable text on purpose: the model's own scratch is never shown as the
 * agent's words, the same rule Antigravity's parser already holds for
 * prose-shaped fields. `step-start`/`step-finish` are markers only — neither
 * carries anything the feed shows.
 *
 * A `tool` part's `input` is read from `state.input` when the state carries
 * one, so a call whose subject IS on disk can still produce an activity line
 * through the shared `toolActivityLine` table; a call whose state carries
 * none simply produces no line, exactly like every other unrecognised or
 * subject-less tool call already does.
 */
export type OpenCodePart =
  | { type: 'text'; text: string }
  | { type: 'reasoning' }
  | { type: 'tool'; tool: string; callId: string; status?: string; input?: Record<string, unknown> }
  | { type: 'step-start' }
  | { type: 'step-finish' }

export function parseOpenCodePartData(rawData: unknown): OpenCodePart | null {
  const data = parseJsonRecord(rawData)
  if (data === null) return null
  switch (data.type) {
    case 'text': {
      const text = asString(data.text)
      return text === undefined ? null : { type: 'text', text }
    }
    case 'reasoning':
      return { type: 'reasoning' }
    case 'tool': {
      const tool = asString(data.tool)
      const callId = asString(data.callID)
      if (tool === undefined || callId === undefined) return null
      const state = isRecord(data.state) ? data.state : undefined
      const status = asString(state?.status)
      const input = isRecord(state?.input) ? (state.input as Record<string, unknown>) : undefined
      return {
        type: 'tool',
        tool,
        callId,
        ...(status === undefined ? {} : { status }),
        ...(input === undefined ? {} : { input })
      }
    }
    case 'step-start':
      return { type: 'step-start' }
    case 'step-finish':
      return { type: 'step-finish' }
    default:
      return null
  }
}

/** One `message` row, as `state.ts` reads it — `data` is still the raw JSON blob. */
export interface OpenCodeMessageRow {
  id: string
  timeCreatedMs: number
  data: unknown
}

/** One `part` row, joined to its owning message by id. */
export interface OpenCodePartRow {
  id: string
  messageId: string
  timeCreatedMs: number
  data: unknown
}

/** Stable order: `time_created` first, `id` breaks a tie — the measured index shape. */
function byTimeThenId<T extends { timeCreatedMs: number; id: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    if (a.timeCreatedMs !== b.timeCreatedMs) return a.timeCreatedMs - b.timeCreatedMs
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

function isoTimestamp(ms: number): string {
  return new Date(ms).toISOString()
}

/**
 * `message` × `part` rows → the panel's feed [V row 3, D1 feed rules].
 *
 * Ordered by `message.time_created, message.id` and then part order, on the
 * measured indexes (`message_session_time_created_id_idx`,
 * `part_message_id_id_idx`). A `user` message becomes one `role: 'user'` row
 * per `text` part it owns; each `text` part of an assistant message becomes
 * one `role: 'assistant'` row; `reasoning` parts never surface; `tool` parts
 * become one `activity` line each, spelled through the shared
 * `toolActivityLine` table Codex and Antigravity already use;
 * `step-start`/`step-finish` emit nothing.
 */
export function openCodeFeedRows(
  messages: readonly OpenCodeMessageRow[],
  parts: readonly OpenCodePartRow[]
): FeedMessage[] {
  const partsByMessage = new Map<string, OpenCodePartRow[]>()
  for (const part of parts) {
    const owned = partsByMessage.get(part.messageId)
    if (owned === undefined) partsByMessage.set(part.messageId, [part])
    else owned.push(part)
  }

  const feed: FeedMessage[] = []
  for (const messageRow of byTimeThenId(messages)) {
    const message = parseOpenCodeMessageData(messageRow.data)
    if (message === null) continue
    for (const partRow of byTimeThenId(partsByMessage.get(messageRow.id) ?? [])) {
      const part = parseOpenCodePartData(partRow.data)
      if (part === null) continue
      const timestamp = isoTimestamp(partRow.timeCreatedMs)
      if (part.type === 'text') {
        feed.push({ role: message.role, text: part.text, timestamp })
        continue
      }
      if (part.type === 'tool') {
        const line = toolActivityLine(part.tool, part.input ?? {})
        if (line !== undefined) feed.push({ ...line, timestamp })
      }
      // reasoning, step-start, step-finish: nothing enters the feed.
    }
  }
  return feed
}

/**
 * The newest `text` part of the newest `role: 'assistant'` message, or
 * `undefined` when the session has not replied yet.
 */
export function lastAssistantText(
  messages: readonly OpenCodeMessageRow[],
  parts: readonly OpenCodePartRow[]
): string | undefined {
  const assistantRows = byTimeThenId(
    messages.filter((row) => parseOpenCodeMessageData(row.data)?.role === 'assistant')
  )
  const newest = assistantRows[assistantRows.length - 1]
  if (newest === undefined) return undefined

  const ownParts = byTimeThenId(parts.filter((part) => part.messageId === newest.id))
  for (let index = ownParts.length - 1; index >= 0; index--) {
    const part = parseOpenCodePartData(ownParts[index]!.data)
    if (part?.type === 'text') return part.text
  }
  return undefined
}
