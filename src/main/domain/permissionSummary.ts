import { redactSecrets } from './redactSecrets'

/**
 * The one line a permission card shows for a tool's structured input (#203).
 *
 * Lives in `domain/` rather than beside either caller because both callers
 * need the SAME rule and neither owns it. A held session's prompt arrives
 * through `canUseTool` (sessionLaunch/heldSession.ts) and an observed
 * session's is read off an unresolved `tool_use` in the transcript
 * (providers/claude/claudeProvider.ts) — two sources, one card, and a second
 * copy of the summary rule is how the same Bash call comes to read one way
 * for a session the panel holds and another for one it only watches.
 */

/**
 * The input fields worth showing, checked in this order — the first one
 * present wins. Every tool this app has seen prompt names its subject through
 * exactly one of these, and a tool this list does not recognise falls through
 * to the whole input as JSON rather than showing nothing.
 */
const PERMISSION_SUMMARY_FIELDS = ['command', 'file_path', 'path', 'url', 'pattern'] as const

/**
 * The cap on a permission prompt's input summary. A pasted file, or a command
 * with a long inline payload, must never become the whole card — the same
 * reasoning HELD_MESSAGE_MAX_CHARS applies to a held message.
 */
export const PERMISSION_INPUT_MAX_CHARS = 240

/**
 * A short, human string for a tool's input, before the cap and redaction.
 * Never the whole input object unless nothing named above is a string: that
 * fallback stays JSON so a tool this table does not recognise still shows
 * SOMETHING, at the cost of reading like a payload rather than a sentence.
 */
function summarizePermissionInput(input: Record<string, unknown>): string {
  for (const field of PERMISSION_SUMMARY_FIELDS) {
    const value = input[field]
    if (typeof value === 'string') return value
  }
  return JSON.stringify(input)
}

/**
 * That summary, capped and redacted — the exact string `DwarfPermissionRequest.input`
 * carries, whichever kind of session raised the prompt.
 *
 * Capped BEFORE redaction, which is only safe because `redactSecrets` matches
 * a truncated key as readily as a whole one (see its own module comment): the
 * cap cannot leave half a key standing, and doing it in this order means the
 * redactor never walks a five-thousand-character paste to rewrite the 240
 * characters anybody will read.
 */
export function permissionInputLine(input: Record<string, unknown>): string {
  return redactSecrets(summarizePermissionInput(input).slice(0, PERMISSION_INPUT_MAX_CHARS))
}
