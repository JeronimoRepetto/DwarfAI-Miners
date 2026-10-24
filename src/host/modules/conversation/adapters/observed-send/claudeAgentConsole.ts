// The pure reader of a Claude Code lead terminal's screen (AMENDMENT-29, owner 2026-10-24; spike
// odd/handoff/spike-claude-subagent-terminal-input.md §2): what the observed-subagent route
// (ClaudeSubagentConsoleSend.ts) reads before every key it presses. Adapter-local, because the
// layout is Claude Code's own TUI (R12): no other provider's screen is read.
//
// The layout it reads (Claude Code 2.1.310, measured by `CONOUT$` captures on 2026-10-24,
// fixtures/claude/observer/2.1.310), from the input box down:
//
//     ──────────────────────────────── <label> ─    the input's top rule; the label only in a subagent's view
//     ❯ <input>                                     the glyph, a no-break space, the input (more lines below
//                                                   it for a multi-line draft)
//     ──────────────────────────────────────────    the input's bottom rule
//       <status line>
//       <hint>                                      `↑/↓ to select`, `Enter to view · x to stop …`, …
//
//     ❯ ● main                                      the agent list: `main` first, the pointer on the selected
//       ◯ <agentType>  <row label>   <elapsed> · ↓ <tokens>   row; ● marks the open view, ◯ the others
//
// - The view label is the open subagent's `description` (its `agent-<id>.meta.json`); the lead's own
//   view has a bare rule. A description too long for the window is cut short with `…` (the rule then
//   starts with the label), so it never equals the description: the route refuses (`not-found`). A
//   row's label is the description at first, then a live activity summary, cut short too, so it is
//   never an identity: only the view label is verified.
// - The input is empty only when nothing follows the prompt glyph, or, in a subagent's view, the
//   measured placeholder `Message @<agentType>…` alone. Anything else is the person's draft, which the
//   route never sends or clears (spike §5: the input is shared between the views). A new session's
//   suggestion (`Try "…"`) reads as a draft: neither its characters, its colours (ConPTY keeps them
//   out of the console attributes) nor the cursor tell it from typed text (measured), and a session
//   with no message has no subagent yet.
// - The selected row is the one the pointer is on; no pointer means the input has the focus.
// - Anything else — no input box, a box without its bottom rule, a pointer on two rows, a row that
//   does not read — is no screen at all (null): the route refuses rather than press a key blind.
// Nothing here logs a line of the screen.

/** What the lead terminal shows, as far as the route needs it. */
export interface AgentConsoleScreen {
  /** The open subagent view's rule label (its `description`); null on the lead's own view. */
  viewLabel: string | null
  /** Whether the input line is positively empty. */
  inputEmpty: boolean
  /** The agent list in screen order: `main` first, then one row per subagent; empty when none shows. */
  rows: ReadonlyArray<{ label: string }>
  /** The index in `rows` of the row the pointer is on; null while the input has the focus. */
  selected: number | null
}

/** The prompt glyph before the input, and the list pointer. */
const POINTER = '❯'
/** A bare rule: the input box's bottom rule, or its top rule on the lead's own view. */
const BARE_RULE = /^─{8,}$/
/**
 * A labelled top rule: rule characters, the label, one or more rule characters (`── label ─`); a
 * label cut short fills the row from its start (` label… ─`).
 */
const LABELLED_RULE = /^(?:─+)? (.*\S) ─+$/
/** The prompt line: the glyph, then a (no-break) space and the input, or nothing. */
const PROMPT = /^❯(?:\s(.*))?$/
/** The placeholder of an empty input in a subagent's view (`Message @general-purpose…`). */
const AGENT_PLACEHOLDER = /^Message @[A-Za-z0-9._:-]+…?$/
/** The `main` row: the pointer or two spaces, the bullet (● the open view, ◯ not), `main`. */
const MAIN_ROW = /^(?:❯ | {2})[●◯] main$/
/** A subagent row: the pointer or two spaces, the bullet, its agent type, two spaces, the rest. */
const AGENT_ROW = /^(❯ | {2})[●◯] \S+ {2}(.+)$/
/** The elapsed time and tokens that end a subagent row (`18s · ↓ 51.4k tokens`, `1m 2s · …`). */
const ROW_TAIL = /\s+(?:\d+h )?(?:\d+m )?\d+s · .*$/

function isRule(line: string): boolean {
  return BARE_RULE.test(line) || LABELLED_RULE.test(line)
}

/** The screen `lines` show (one string per window row, top to bottom), or null when it does not read. */
export function readAgentConsole(lines: readonly string[]): AgentConsoleScreen | null {
  const rows = lines.map((line) => line.trimEnd())
  // The input box's bottom rule: the last bare rule on the screen (nothing under the box is a rule).
  let bottom = -1
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (BARE_RULE.test(rows[index]!)) {
      bottom = index
      break
    }
  }
  if (bottom < 2) return null
  // Its top rule: the nearest rule above, with the prompt line right under it.
  let top = -1
  for (let index = bottom - 1; index >= 0; index -= 1) {
    if (isRule(rows[index]!)) {
      top = index
      break
    }
  }
  if (top < 0 || top === bottom - 1) return null
  const prompt = PROMPT.exec(rows[top + 1]!)
  if (prompt === null) return null
  const labelled = LABELLED_RULE.exec(rows[top]!)
  const viewLabel = labelled === null ? null : labelled[1]!
  const typed = (prompt[1] ?? '').trim()
  const continued = rows.slice(top + 2, bottom).some((line) => line.trim() !== '')
  const inputEmpty =
    !continued && (typed === '' || (viewLabel !== null && AGENT_PLACEHOLDER.test(typed)))

  const list = readList(rows.slice(bottom + 1))
  if (list === null) return null
  return { viewLabel, inputEmpty, ...list }
}

/** The agent list under the input box, or null when its rows do not read. */
function readList(under: readonly string[]): Pick<AgentConsoleScreen, 'rows' | 'selected'> | null {
  const start = under.findIndex((line) => MAIN_ROW.test(line))
  if (start < 0) return { rows: [], selected: null }
  const rows: Array<{ label: string }> = [{ label: 'main' }]
  const pointed: number[] = under[start]!.startsWith(POINTER) ? [0] : []
  for (const line of under.slice(start + 1)) {
    const row = AGENT_ROW.exec(line)
    if (row === null) break
    if (row[1] === `${POINTER} `) pointed.push(rows.length)
    rows.push({ label: row[2]!.replace(ROW_TAIL, '').trim() })
  }
  if (rows.length < 2 || pointed.length > 1) return null
  // A pointer anywhere else under the box (a row that did not read) is a list it cannot place.
  const listEnd = start + rows.length
  if (under.slice(listEnd).some((line) => line.startsWith(POINTER))) return null
  return { rows, selected: pointed[0] ?? null }
}
