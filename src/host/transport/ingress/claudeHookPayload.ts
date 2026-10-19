// The body of a Claude Code hook relayed to the loopback ingress (`/hooks/claude/*`; ADR-016 items 2
// and 4). Evaluated candidate: the legacy `hooks/hookPayload.ts` (found tree), whose rules are kept —
// a JSON object or nothing, an event name from a closed set or nothing, own properties only — and
// rewritten as a zod schema; its lenient "a malformed optional field still earns a rescan" rule is
// not kept, because the ingress validates by a strict schema: a field of the wrong type refuses the
// whole body.
//
// What is strict: the body is a JSON object; `hook_event_name` is one of CLAUDE_HOOK_EVENTS; each
// field DwarfAI reads has its type and a length bound. What is not: the other fields Claude Code
// sends (`message`, `permission_mode`, `tool_input`, …) and the fields later versions add are
// dropped unread, so a newer Claude Code never breaks the ingress and nothing DwarfAI does not read
// travels further (ADR-016 item 4: evidence, never commands).
import { z } from 'zod'

/**
 * The Claude Code hook events the ingress accepts. Package gap (ISSUE-133): the package names no
 * event list; this is the legacy five plus the documented permission and tool events that
 * ISSUE-134's permission-prompt evidence and the observer's nudge can use. One list, extended
 * here when the hook entry (ISSUE-220) installs another event.
 */
export const CLAUDE_HOOK_EVENTS = [
  // Never arrives over HTTP: Claude Code runs `SessionStart` hooks only as `type: "command"` or
  // `type: "mcp_tool"` (https://code.claude.com/docs/en/hooks), so ISSUE-220 must not install it
  // as an http hook. Kept for a command hook that relays it to the ingress.
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'Notification',
  'PermissionRequest',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SubagentStop'
] as const

export type ClaudeHookEventName = (typeof CLAUDE_HOOK_EVENTS)[number]

/** What an accepted hook event hands on: data only, never a callback (ADR-016 item 4). */
export interface ClaudeHookEvidence {
  event: ClaudeHookEventName
  /** Claude Code's own session id. */
  sessionId?: string
  /** The session's working directory. */
  cwd?: string
  /** The session's transcript file. */
  transcriptPath?: string
  /** What a `Notification` wants, such as `permission_prompt`; an open vocabulary. */
  notificationType?: string
  /** The tool of a permission or tool event. */
  toolName?: string
}

/** Longest text field read: a path or an id never comes near it. */
const MAX_FIELD_CHARS = 4_096

/** Text with something in it besides blanks, handed on exactly as sent (a path may end in a space). */
const text = z
  .string()
  .max(MAX_FIELD_CHARS)
  .refine((value) => value.trim().length > 0)

const claudeHookPayload = z.object({
  hook_event_name: z.enum(CLAUDE_HOOK_EVENTS),
  session_id: text.optional(),
  cwd: text.optional(),
  transcript_path: text.optional(),
  notification_type: text.optional(),
  tool_name: text.optional()
})

/** The evidence of one hook body, or `null` when the body fails the schema. */
export function parseClaudeHookPayload(body: string): ClaudeHookEvidence | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  // Own properties only, so a crafted `__proto__` cannot smuggle a field in.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const result = claudeHookPayload.safeParse(Object.fromEntries(Object.entries(parsed)))
  if (!result.success) return null
  const payload = result.data
  return {
    event: payload.hook_event_name,
    ...optional('sessionId', payload.session_id),
    ...optional('cwd', payload.cwd),
    ...optional('transcriptPath', payload.transcript_path),
    ...optional('notificationType', payload.notification_type),
    ...optional('toolName', payload.tool_name)
  }
}

function optional<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, string>)
}
