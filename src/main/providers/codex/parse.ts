import type { FeedMessage } from '../../domain/types'

/**
 * Pure parsers for Codex CLI rollout files (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl).
 * Every record is {timestamp, type, payload} — see docs/provider-formats.md.
 */

/** Session identity from the session_meta record (line 1 of a rollout). */
export interface CodexRolloutHead {
  sessionId: string
  cwd: string
  /** Present only for a Codex subagent spawned by another thread. */
  parentSessionId?: string
  /** Provider-supplied nickname for a spawned Codex subagent. */
  agentName?: string
}

/** Live state read from the tail of a rollout. */
export interface CodexRolloutInfo {
  model?: string
  effort?: string
  /** True when the last task_started has no matching task_complete or turn_aborted. */
  busy: boolean
  lastMessage?: string
}

/** Model settings found in one or more `turn_context` records. */
export interface CodexRolloutContext {
  model?: string
  effort?: string
}

type Rec = Record<string, unknown>

function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function jsonlRecords(text: string): { type: string; payload: Rec; timestamp: string }[] {
  const records: { type: string; payload: Rec; timestamp: string }[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (isRecord(parsed) && typeof parsed.type === 'string' && isRecord(parsed.payload)) {
        records.push({
          type: parsed.type,
          payload: parsed.payload,
          timestamp: asString(parsed.timestamp) ?? ''
        })
      }
    } catch {
      // partial or corrupt line — skip
    }
  }
  return records
}

/** Parse the head of a rollout for the session_meta identity; null when absent. */
export function parseCodexRolloutHead(headText: string): CodexRolloutHead | null {
  for (const record of jsonlRecords(headText)) {
    if (record.type !== 'session_meta') continue
    const sessionId = asString(record.payload.id) ?? asString(record.payload.session_id)
    const cwd = asString(record.payload.cwd)
    if (sessionId === undefined || cwd === undefined) return null
    const source = record.payload.source
    const subagent = isRecord(source) ? source.subagent : undefined
    const threadSpawn = isRecord(subagent) ? subagent.thread_spawn : undefined
    const head: CodexRolloutHead = { sessionId, cwd }
    if (isRecord(threadSpawn)) {
      const parentSessionId = asString(threadSpawn.parent_thread_id)
      const agentName = asString(threadSpawn.agent_nickname)
      if (parentSessionId !== undefined) head.parentSessionId = parentSessionId
      if (agentName !== undefined) head.agentName = agentName
    }
    return head
  }
  return null
}

function outputText(payload: Rec): string | undefined {
  if (!Array.isArray(payload.content)) return undefined
  const texts = payload.content
    .filter(isRecord)
    .filter((block) => block.type === 'output_text')
    .map((block) => asString(block.text) ?? '')
    .filter((text) => text !== '')
  return texts.length > 0 ? texts.join('\n') : undefined
}

/**
 * Reads the latest model/effort available in a complete rollout fragment.
 *
 * `turn_context` is normally emitted near the start of a turn. Large turns can
 * push it outside a tail read, so providers use this on the rollout head as a
 * fallback only; tail context remains authoritative for newer turns.
 */
export function parseCodexRolloutContext(text: string): CodexRolloutContext {
  let model: string | undefined
  let effort: string | undefined

  for (const record of jsonlRecords(text)) {
    if (record.type !== 'turn_context') continue
    model = asString(record.payload.model) ?? model
    effort = asString(record.payload.effort) ?? effort
  }

  return { model, effort }
}

/** Extract model/effort, open-turn state and the latest reply from a rollout tail. */
export function parseCodexRolloutTail(tailText: string): CodexRolloutInfo {
  const context = parseCodexRolloutContext(tailText)
  let lastMessage: string | undefined
  let openTurnId: string | null | undefined

  for (const record of jsonlRecords(tailText)) {
    if (record.type === 'response_item') {
      if (record.payload.type === 'message' && record.payload.role === 'assistant') {
        lastMessage = outputText(record.payload) ?? lastMessage
      }
      continue
    }
    if (record.type !== 'event_msg') continue
    switch (record.payload.type) {
      case 'task_started':
        openTurnId = asString(record.payload.turn_id) ?? null
        break
      case 'task_complete': {
        const turnId = asString(record.payload.turn_id)
        // Close the open turn when ids match, or when either side has no id.
        if (openTurnId === null || turnId === undefined || turnId === openTurnId) {
          openTurnId = undefined
        }
        lastMessage = asString(record.payload.last_agent_message) ?? lastMessage
        break
      }
      case 'turn_aborted': {
        // The user interrupted the turn (verified real payload shape:
        // {"type":"turn_aborted","turn_id":"…","reason":"interrupted",…}).
        // Structurally this ends the turn exactly like task_complete: without
        // it the unmatched task_started keeps the dwarf mining forever after
        // an Esc, even though the agent sits at the prompt (issue #34).
        const turnId = asString(record.payload.turn_id)
        if (openTurnId === null || turnId === undefined || turnId === openTurnId) {
          openTurnId = undefined
        }
        break
      }
      case 'agent_message':
        lastMessage = asString(record.payload.message) ?? lastMessage
        break
    }
  }

  return { ...context, busy: openTurnId !== undefined, lastMessage }
}

/**
 * The last `limit` human-readable messages of a rollout: user_message events
 * and assistant response_items. agent_message events are skipped because they
 * duplicate the response_item text of the same reply.
 */
export function extractCodexFeed(tailText: string, limit: number): FeedMessage[] {
  const feed: FeedMessage[] = []
  for (const record of jsonlRecords(tailText)) {
    if (record.type === 'event_msg' && record.payload.type === 'user_message') {
      const text = asString(record.payload.message)
      if (text !== undefined) feed.push({ role: 'user', text, timestamp: record.timestamp })
      continue
    }
    if (
      record.type === 'response_item' &&
      record.payload.type === 'message' &&
      record.payload.role === 'assistant'
    ) {
      const text = outputText(record.payload)
      if (text !== undefined) feed.push({ role: 'assistant', text, timestamp: record.timestamp })
    }
  }
  return feed.slice(-limit)
}
