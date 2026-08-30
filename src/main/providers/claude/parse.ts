import type { FeedMessage, SessionStatus } from '../../domain/types'
import type { TextDeliveryTarget } from '../../textDelivery/port'

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
  /**
   * What the session is blocked on while status is 'waiting' (e.g. "dialog
   * open"), copied verbatim from the registry. Structured evidence only —
   * never derived from assistant text (issue #34).
   */
  waitingFor?: string
  /**
   * Windows FILETIME process start value. The pid-reuse guard compares it
   * against the pid's real creation time (see ClaudeProvider.procStartVerdict)
   * so a registry file that outlived its process cannot make the recycled
   * pid's window a focus/Send/Kick target.
   */
  procStart?: string
  /**
   * How the session was started: 'interactive' for a TUI the user is looking
   * at, 'bg' for a headless background job. This is what decides whether a
   * typed message can be injected into a console or has to be relayed.
   */
  kind?: string
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
  /**
   * Every agent id seen reaching a terminal status in this tail, whether or not
   * its launch record is still in the window. The provider remembers these
   * across polls so a finished agent can never come back (see claudeProvider).
   */
  terminalAgentIds: string[]
  pendingBackgroundAgentCount?: number
  /**
   * The latest usage block seen in this tail (input+output+cache tokens for
   * that one turn), used by the provider as a floor for its runtime-lifetime
   * counter — see ClaudeProvider. Not a sum across turns: Claude resends the
   * whole conversation each turn, so summing input_tokens across turns would
   * wildly over-count. "Latest observed" is the honest cheap approximation.
   */
  tokensObserved?: number
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
    // The registry reports busy, idle or waiting — waiting means "alive but
    // blocked" (on user input, a dialog, a long tool), with waitingFor naming
    // the condition. That structured lifecycle signal is preserved (issue #34);
    // only unknown values normalize to idle, the conservative reading. The
    // main session dwarf is a foreman either way — status changes, rank does not.
    status: json.status === 'busy' ? 'busy' : json.status === 'waiting' ? 'waiting' : 'idle',
    waitingFor: asString(json.waitingFor),
    procStart: asString(json.procStart),
    kind: asString(json.kind),
    name: asString(json.name),
    startedAt: asNumber(json.startedAt),
    updatedAt: asNumber(json.updatedAt)
  }
}

/**
 * Which channel a Claude session can receive typed text through.
 *
 * A headless job ('bg') has no console to type into, but Claude Code keeps
 * every session on this machine addressable by the name in its registry entry,
 * so a relay turn can hand it the message. Anything else — including an older
 * entry that records no kind at all — is assumed to own a console: those
 * predate background sessions, so a console is the safe reading.
 *
 * Interactive sessions get names too, and that name is the exact same relay
 * address a bg session uses. It rides along on the terminal target so the
 * runtime can fall back to the relay when the console cannot be focused or
 * typed into, instead of losing the message entirely (issue #24).
 */
export function claudeSessionDeliveryTarget(session: {
  pid: number
  kind?: string
  name?: string
}): TextDeliveryTarget | null {
  if (session.kind === 'bg') {
    return session.name === undefined ? null : { kind: 'claude-relay', sessionName: session.name }
  }
  return session.name === undefined
    ? { kind: 'terminal', pid: session.pid }
    : { kind: 'terminal', pid: session.pid, sessionName: session.name }
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

/**
 * Sum of input+output+cache tokens on one assistant line's usage block, or
 * undefined when there is none (older transcripts, or a line the API never
 * attached usage to). Read cheaply from data the bounded tail already parses.
 */
function usageTokens(message: unknown): number | undefined {
  if (!isRecord(message) || !isRecord(message.usage)) return undefined
  const usage = message.usage
  const total =
    (asNumber(usage.input_tokens) ?? 0) +
    (asNumber(usage.output_tokens) ?? 0) +
    (asNumber(usage.cache_creation_input_tokens) ?? 0) +
    (asNumber(usage.cache_read_input_tokens) ?? 0)
  return total > 0 ? total : undefined
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

/**
 * Terminal statuses a `<task-notification>` can report. `killed` is the one an
 * accidental stop writes — leaving it out was the ghost-dwarf bug: the agent
 * never notified as completed, so it mined forever (see docs/provider-formats.md).
 */
const TASK_NOTIFICATION_RE =
  /<task-id>([^<]+)<\/task-id>[\s\S]*?<status>(completed|failed|killed)<\/status>/g

/**
 * Extract model/effort, the latest assistant text and the set of in-flight
 * subagents from the tail of a session (or subagent) transcript.
 *
 * An agent is in flight when a `toolUseResult.status == "async_launched"` line
 * exists with no task-notification for the same task-id in this tail.
 */
export function parseClaudeTranscriptTail(tailText: string): ClaudeTranscriptInfo {
  let model: string | undefined
  let effort: string | undefined
  let lastAssistantText: string | undefined
  let pendingBackgroundAgentCount: number | undefined
  let tokensObserved: number | undefined
  const launched = new Map<string, ClaudeInFlightAgent>()
  const finished = new Set<string>()

  for (const line of jsonlObjects(tailText)) {
    if (line.type === 'assistant') {
      if (isRecord(line.message)) model = asString(line.message.model) ?? model
      effort = asString(line.effort) ?? effort
      lastAssistantText = assistantText(line) ?? lastAssistantText
      tokensObserved = usageTokens(line.message) ?? tokensObserved
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
    terminalAgentIds: [...finished],
    pendingBackgroundAgentCount,
    tokensObserved
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
