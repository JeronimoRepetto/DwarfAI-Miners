/**
 * Shaping OpenCode's `permission.asked` / `permission.replied` plugin events
 * (docs/opencode-format.md Rows 15/16, #588) into the payload this app will
 * eventually route once a push channel exists to carry it.
 *
 * This is main-process-internal only. It does NOT touch `shared/contracts.ts`
 * — the wire boundary AGENTS.md reserves for main <-> preload <-> renderer —
 * because nothing crosses that boundary yet: T3 (HookChannel changes), T4
 * (provider wiring) and T5 (the answer path) are what will eventually route a
 * built payload to something the renderer can read, and only THAT slice earns
 * the contracts.ts entry. Until then this is a pure, tested function with no
 * channel behind it.
 *
 * `serverUrl` is not a convenience field: every OpenCode instance binds its
 * own arbitrary port when none is pinned on launch (#588 T2 STEP 0, verified
 * against the OS's own listening socket, not just the plugin's self-report),
 * so this is the ONLY place that address is ever recorded. Whatever answers
 * this prompt later (T5) has nowhere else to read it from.
 *
 * Everything is rejected rather than repaired, mirroring `hookPayload.ts`'s
 * `parseClaudeHookPayload`: a body that is not a JSON object, an event whose
 * `type` this app does not forward, or a required field of the wrong shape
 * all come back `null`. The optional fields are best-effort, exactly as
 * there — a payload with a usable id but a malformed `patterns` array still
 * produces a payload, just without `patterns`.
 */

interface OpenCodePermissionAskedPush {
  provider: 'opencode'
  kind: 'asked'
  serverUrl: string
  sessionId: string
  requestId: string
  /** OpenCode's own permission kind, e.g. `"bash"`. */
  permission: string
  /** The glob patterns this ask matched against, when the event carried any. */
  patterns?: string[]
  /** The command text, when `metadata.command` was a usable string. */
  command?: string
  /** The blocked tool call's id, when `tool.callID` was a usable string. */
  callId?: string
}

interface OpenCodePermissionRepliedPush {
  provider: 'opencode'
  kind: 'replied'
  serverUrl: string
  sessionId: string
  requestId: string
  /** OpenCode's own reply vocabulary, e.g. `"once"`. Passed through verbatim. */
  reply: string
}

export type OpenCodePermissionPush = OpenCodePermissionAskedPush | OpenCodePermissionRepliedPush

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A non-blank string, own-property only — never a value inherited off the prototype. */
function requiredText(source: Record<string, unknown>, key: string): string | undefined {
  if (!Object.hasOwn(source, key)) return undefined
  const value = source[key]
  if (typeof value !== 'string') return undefined
  return value.trim() === '' ? undefined : value
}

/** Every element must be a string, or the whole array is dropped rather than filtered. */
function optionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  return value.every((item) => typeof item === 'string') ? (value as string[]) : undefined
}

function buildAsked(
  properties: Record<string, unknown>,
  serverUrl: string
): OpenCodePermissionAskedPush | null {
  const requestId = requiredText(properties, 'id')
  const sessionId = requiredText(properties, 'sessionID')
  const permission = requiredText(properties, 'permission')
  if (requestId === undefined || sessionId === undefined || permission === undefined) return null

  const metadata = isRecord(properties.metadata) ? properties.metadata : {}
  const tool = isRecord(properties.tool) ? properties.tool : {}
  const command = requiredText(metadata, 'command')
  const callId = requiredText(tool, 'callID')
  const patterns = optionalStringArray(properties.patterns)

  return {
    provider: 'opencode',
    kind: 'asked',
    serverUrl,
    sessionId,
    requestId,
    permission,
    ...(patterns === undefined ? {} : { patterns }),
    ...(command === undefined ? {} : { command }),
    ...(callId === undefined ? {} : { callId })
  }
}

function buildReplied(
  properties: Record<string, unknown>,
  serverUrl: string
): OpenCodePermissionRepliedPush | null {
  const sessionId = requiredText(properties, 'sessionID')
  const requestId = requiredText(properties, 'requestID')
  const reply = requiredText(properties, 'reply')
  if (sessionId === undefined || requestId === undefined || reply === undefined) return null

  return { provider: 'opencode', kind: 'replied', serverUrl, sessionId, requestId, reply }
}

/**
 * Parse one raw OpenCode plugin event into this app's push payload, or null
 * when it is not one of the two events the plugin forwards
 * (`opencodePermissionPlugin.ts`) or is missing a field this payload cannot
 * exist without.
 */
export function buildOpenCodePermissionPush(
  event: unknown,
  serverUrl: URL
): OpenCodePermissionPush | null {
  if (!isRecord(event)) return null
  if (!Object.hasOwn(event, 'type')) return null
  const properties = event.properties
  if (!isRecord(properties)) return null

  const href = serverUrl.href
  switch (event.type) {
    case 'permission.asked':
      return buildAsked(properties, href)
    case 'permission.replied':
      return buildReplied(properties, href)
    default:
      return null
  }
}
