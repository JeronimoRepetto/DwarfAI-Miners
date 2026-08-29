/**
 * The Claude Code hook events DwarfAI-Miners installs, and therefore the only
 * ones it accepts back.
 *
 * These five are exactly the state-change moments the 2 s poller is late for:
 * a session appearing, a turn ending, the CLI asking for attention, a subagent
 * finishing, a session closing. Per-tool-call events (PreToolUse/PostToolUse)
 * are deliberately absent — they fire many times per turn and buy no extra
 * information, since every event here triggers the same full rescan.
 */
export const CLAUDE_HOOK_EVENTS = [
  'SessionStart',
  'Notification',
  'Stop',
  'SubagentStop',
  'SessionEnd'
] as const

export type ClaudeHookEvent = (typeof CLAUDE_HOOK_EVENTS)[number]

/** One accepted push event. Carries only what is worth logging: the scan is a full rescan. */
export interface HookEvent {
  provider: 'claude'
  event: ClaudeHookEvent
  /** Claude's own session id, when the payload carried one. */
  sessionId?: string
  /** The session's working directory, when the payload carried one. */
  cwd?: string
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A trimmed non-empty string, or undefined for anything else. */
function optionalText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function isInstalledEvent(value: unknown): value is ClaudeHookEvent {
  return typeof value === 'string' && (CLAUDE_HOOK_EVENTS as readonly string[]).includes(value)
}

/**
 * Parse the JSON body a Claude hook relays, or null when it is not one of ours.
 *
 * Everything is rejected rather than repaired: a body that is not a JSON
 * object, an event name outside the installed set, or a missing event name.
 * The optional fields are best-effort — a payload with a usable event name but
 * a malformed session id still earns a rescan, because the rescan does not
 * depend on any of them. Own properties only, so a crafted `__proto__` cannot
 * smuggle an event name in.
 */
export function parseClaudeHookPayload(body: string): HookEvent | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  if (!isJsonObject(parsed)) return null
  if (!Object.hasOwn(parsed, 'hook_event_name')) return null

  const event = parsed.hook_event_name
  if (!isInstalledEvent(event)) return null

  const sessionId = optionalText(parsed.session_id)
  const cwd = optionalText(parsed.cwd)
  return {
    provider: 'claude',
    event,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(cwd === undefined ? {} : { cwd })
  }
}
