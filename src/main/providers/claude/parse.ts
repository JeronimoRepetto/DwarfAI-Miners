import type { FeedMessage, SessionStatus } from '../../domain/types'

/**
 * Pure parsers for Claude Code on-disk session data. They take strings/objects
 * and return plain data — no filesystem or process access (see docs/provider-formats.md).
 */

/** One live session from ~/.claude/sessions/<pid>.json. */
export interface ClaudeSessionEntry {
  pid: number
  sessionId: string
  cwd: string
  status: SessionStatus
  name?: string
  startedAt?: number
  updatedAt?: number
}

/** A subagent launched with the Agent tool that has not completed yet. */
export interface ClaudeInFlightAgent {
  agentId: string
  description?: string
  resolvedModel?: string
}

/** Everything the provider needs from the tail of a session transcript. */
export interface ClaudeTranscriptInfo {
  model?: string
  effort?: string
  lastAssistantText?: string
  inFlightAgents: ClaudeInFlightAgent[]
  pendingBackgroundAgentCount?: number
}

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
 * Encode a project cwd the way Claude Code names its projects/ directory:
 * every non-alphanumeric character becomes a dash. The encoding is lossy —
 * never decode it; real paths come from the `cwd` field inside transcripts.
 */
export function encodeClaudeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

/** Parse one ~/.claude/sessions/<pid>.json registry entry; null when malformed. */
export function parseClaudeSessionEntry(json: unknown): ClaudeSessionEntry | null {
  if (!isRecord(json)) return null
  const pid = asNumber(json.pid)
  const sessionId = asString(json.sessionId)
  const cwd = asString(json.cwd)
  if (pid === undefined || sessionId === undefined || cwd === undefined) return null
  return {
    pid,
    sessionId,
    cwd,
    status: json.status === 'busy' ? 'busy' : 'idle',
    name: asString(json.name),
    startedAt: asNumber(json.startedAt),
    updatedAt: asNumber(json.updatedAt)
  }
}

/**
 * Parse JSONL text into objects, skipping lines that do not parse (this also
 * silently drops the first partial line a byte-offset tail read produces).
 */
function jsonlObjects(text: string): Rec[] {
  const objects: Rec[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (isRecord(parsed) && typeof parsed.type === 'string') objects.push(parsed)
    } catch {
      // partial or corrupt line — skip
    }
  }
  return objects
}

function contentBlocks(message: unknown): Rec[] {
  if (!isRecord(message) || !Array.isArray(message.content)) return []
  return message.content.filter(isRecord)
}

function assistantText(line: Rec): string | undefined {
  const texts = contentBlocks(line.message)
    .filter((block) => block.type === 'text')
    .map((block) => asString(block.text) ?? '')
    .filter((text) => text !== '')
  return texts.length > 0 ? texts.join('\n') : undefined
}

/** All strings on a user line that may carry a task-notification blob. */
function userContentStrings(line: Rec): string[] {
  if (!isRecord(line.message)) return []
  const content = line.message.content
  if (typeof content === 'string') return [content]
  if (Array.isArray(content)) {
    return content.filter((item): item is string => typeof item === 'string')
  }
  return []
}

const TASK_NOTIFICATION_RE =
  /<task-id>([^<]+)<\/task-id>[\s\S]*?<status>(completed|failed)<\/status>/g

/**
 * Extract model/effort, the latest assistant text and the set of in-flight
 * subagents from the tail of a session (or subagent) transcript.
 *
 * An agent is in flight when a `toolUseResult.status == "async_launched"` line
 * exists with no later task-notification for the same task-id (completed or failed).
 */
export function parseClaudeTranscriptTail(tailText: string): ClaudeTranscriptInfo {
  let model: string | undefined
  let effort: string | undefined
  let lastAssistantText: string | undefined
  let pendingBackgroundAgentCount: number | undefined
  const launched = new Map<string, ClaudeInFlightAgent>()
  const finished = new Set<string>()

  for (const line of jsonlObjects(tailText)) {
    if (line.type === 'assistant') {
      if (isRecord(line.message)) model = asString(line.message.model) ?? model
      effort = asString(line.effort) ?? effort
      lastAssistantText = assistantText(line) ?? lastAssistantText
      continue
    }
    if (line.type === 'user') {
      const result = line.toolUseResult
      if (isRecord(result) && result.status === 'async_launched') {
        const agentId = asString(result.agentId)
        if (agentId !== undefined) {
          launched.set(agentId, {
            agentId,
            description: asString(result.description),
            resolvedModel: asString(result.resolvedModel)
          })
        }
      }
      for (const text of userContentStrings(line)) {
        for (const match of text.matchAll(TASK_NOTIFICATION_RE)) {
          const taskId = match[1]
          if (taskId !== undefined) finished.add(taskId)
        }
      }
      continue
    }
    if (line.type === 'system' && line.subtype === 'turn_duration') {
      pendingBackgroundAgentCount =
        asNumber(line.pendingBackgroundAgentCount) ?? pendingBackgroundAgentCount
    }
  }

  return {
    model,
    effort,
    lastAssistantText,
    inFlightAgents: [...launched.values()].filter((agent) => !finished.has(agent.agentId)),
    pendingBackgroundAgentCount
  }
}

/**
 * The last `limit` human-readable messages of a transcript tail: typed user
 * prompts and assistant text replies. Tool results, task notifications and
 * meta lines are skipped.
 */
export function extractClaudeFeed(tailText: string, limit: number): FeedMessage[] {
  const feed: FeedMessage[] = []
  for (const line of jsonlObjects(tailText)) {
    const timestamp = asString(line.timestamp) ?? ''
    if (line.type === 'user' && line.isMeta !== true && isRecord(line.message)) {
      const content = line.message.content
      if (typeof content === 'string' && !content.startsWith('<')) {
        feed.push({ role: 'user', text: content, timestamp })
      }
      continue
    }
    if (line.type === 'assistant') {
      const text = assistantText(line)
      if (text !== undefined) feed.push({ role: 'assistant', text, timestamp })
    }
  }
  return feed.slice(-limit)
}
