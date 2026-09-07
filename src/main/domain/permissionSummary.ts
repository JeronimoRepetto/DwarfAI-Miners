import { redactSecrets } from './redactSecrets'
import type { FeedActivity, FeedActivityKind, FeedMessage } from './types'

/**
 * The one rule for summarising a tool call, wherever the panel shows one.
 *
 * Lives in `domain/` rather than beside any caller because they all need the
 * SAME rule and none of them owns it. A held session's prompt arrives through
 * `canUseTool` (sessionLaunch/heldSession.ts) and an observed session's is
 * read off an unresolved `tool_use` in the transcript
 * (providers/claude/claudeProvider.ts) — two sources, one card, and a second
 * copy of the summary rule is how the same Bash call comes to read one way
 * for a session the panel holds and another for one it only watches.
 *
 * Two things are asked of it, and the second is why the first is not the
 * whole module (#240). `permissionInputLine` names the subject of a call
 * WAITING on somebody — the card's own line. `toolActivityLine` speaks a call
 * that has already run as one feed line, `Edited <path>` and its three
 * siblings. Both read the same subject field off the same table, so a call
 * reads the same in a permission card and in the line it leaves behind.
 */

/**
 * The input fields worth showing, checked in this order — the first one
 * present wins. Every tool this app has seen prompt names its subject through
 * exactly one of these, and a tool this list does not recognise falls through
 * to the whole input as JSON rather than showing nothing.
 *
 * `pattern` sits ahead of `path` since #240. Grep is the only tool observed
 * carrying both (2022 of its 2080 calls in the corpus docs/provider-formats.md
 * §1.6 tabulates), and the design's `Searched <pattern>` settles which of the
 * two names the call: the pattern is WHAT is being looked for and the path is
 * only where. The card gained the same reading, because there is one rule.
 */
const PERMISSION_SUMMARY_FIELDS = ['command', 'file_path', 'pattern', 'path', 'url'] as const

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
function namedSubject(input: Record<string, unknown>): string | undefined {
  for (const field of PERMISSION_SUMMARY_FIELDS) {
    const value = input[field]
    if (typeof value === 'string') return value
  }
  return undefined
}

function summarizePermissionInput(input: Record<string, unknown>): string {
  return namedSubject(input) ?? JSON.stringify(input)
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

/**
 * The verb each kind of call is spoken with (#240), spelled exactly once.
 *
 * `screens/mine.md`'s activity-line amendment fixes all four words. They are
 * past tense because a feed line is a call that already ran; a card's line
 * carries no verb at all, so the two cannot disagree about tense.
 */
export const ACTIVITY_VERBS: Readonly<Record<FeedActivityKind, string>> = {
  edit: 'Edited',
  run: 'Ran',
  read: 'Read',
  search: 'Searched'
}

/**
 * Which tools get a line, and which verb each is spoken with (#240).
 *
 * Keyed by the tool's own name across every provider — Claude Code's names
 * and Codex's do not collide — so one table answers for all of them and a new
 * provider adds rows rather than a rule. Measured against every transcript on
 * one machine on 2026-09-07 (Claude: 568 transcripts, ~629 MB, 38 573
 * `tool_use` blocks; Codex: 184 rollouts, ~584 MB); the counts are tabulated
 * in docs/provider-formats.md §1.6 and §2.2.
 *
 * A tool this table does not name yields NO line. That is a deliberate miss
 * rather than a fifth verb invented for it: the design names four, `Used`
 * would be a fifth, and this codebase takes a miss over a claim every time.
 * So the omissions are decisions, each of them one of three kinds:
 *
 * - **Not work.** `AskUserQuestion` asks instead of acting and is already
 *   carried whole by `pendingQuestion`; Codex's `wait`, `wait_agent` and
 *   `list_agents` are the agent waiting or looking at itself.
 * - **Agent traffic, drawn as dwarfs already.** Claude's `Agent` and Codex's
 *   `spawn_agent`, `send_message` and `followup_task` each become a dwarf on
 *   the board, which says more than a line would.
 * - **No subject a line could name.** `TodoWrite`, `update_plan` and every
 *   MCP tool measured carry none of the fields above, so even a verb for them
 *   would leave `Ran ` with nothing after it. Codex's `exec` is the pointed
 *   case: 5829 of its calls carry a JavaScript program as their input rather
 *   than a command line, and the first line of a program is not `<command>`.
 */
const TOOL_ACTIVITY_KINDS: Readonly<Record<string, FeedActivityKind>> = {
  // Claude Code. Bash 16119, Read 7254, Edit 6449, Write 2574, Grep 2111,
  // PowerShell 977, Glob 328 and WebFetch 206 calls in the measured corpus;
  // MultiEdit, NotebookEdit and NotebookRead are named by the CLI but were not
  // observed there, and are listed so a notebook edit is not silently dropped.
  Edit: 'edit',
  MultiEdit: 'edit',
  Write: 'edit',
  NotebookEdit: 'edit',
  Bash: 'run',
  PowerShell: 'run',
  Read: 'read',
  NotebookRead: 'read',
  WebFetch: 'read',
  Grep: 'search',
  Glob: 'search',
  // Codex CLI. `shell_command` is a `function_call` whose arguments carry the
  // command as a plain string (404 calls); `apply_patch` is a
  // `custom_tool_call` whose target path the codex parser reads off the patch
  // envelope before calling in here (93 calls).
  shell_command: 'run',
  apply_patch: 'edit'
}

/**
 * One feed line, minus the timestamp its caller owns.
 *
 * Without the stamp because the three callers know three different clocks: a
 * transcript line carries its own, and a held session's stream carries none at
 * all, so the host's is the only honest one there (the same split
 * `HeldSessionStartRequest.onMessage` already draws).
 */
export type FeedActivityLine = Omit<FeedMessage, 'timestamp'> & { activity: FeedActivity }

/**
 * One line, collapsed onto one line. A heredoc, a pasted patch or a command
 * broken across continuations would otherwise put newlines into a row the
 * design says is single-line and truncated at the panel width.
 *
 * Only the feed line does this; a permission card may wrap, and seeing the
 * shape of what is about to run is worth more there than one tidy row.
 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * What one tool call publishes to the feed, or undefined when it publishes
 * nothing (#240) — a tool with no verb in the table above, or one whose input
 * names no subject to put after the verb.
 *
 * Capped and redacted here, before the value is ever a message: `target`
 * crosses processes exactly as `lastMessage` does, and the boundary maps that
 * redact a feed's `text` do not reach inside `activity`. The cap runs before
 * redaction for the reason `permissionInputLine` documents at length.
 */
export function toolActivityLine(
  toolName: string,
  input: Record<string, unknown>
): FeedActivityLine | undefined {
  const kind = TOOL_ACTIVITY_KINDS[toolName]
  if (kind === undefined) return undefined
  const subject = namedSubject(input)
  if (subject === undefined) return undefined
  const target = redactSecrets(oneLine(subject).slice(0, PERMISSION_INPUT_MAX_CHARS))
  if (target === '') return undefined
  return {
    role: 'assistant',
    text: `${ACTIVITY_VERBS[kind]} ${target}`,
    activity: { kind, target }
  }
}
