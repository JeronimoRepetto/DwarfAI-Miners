// The Claude Code 2.1.310 lead-terminal screens of fixtures/claude/observer/2.1.310
// (`console-<state>.json`, AMENDMENT-29), as the console reader hands them: one string per row of
// the visible window. They are real `CONOUT$` captures of the validation run of 2026-10-24, the
// transcript area and the person's status line scrubbed (the folder's meta.json says how).
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const AGENT_CONSOLE_SCREENS = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../../../fixtures/claude/observer/2.1.310'
)

export type AgentConsoleScreenName =
  /** A new session: no message yet, the input shows a `Try "…"` suggestion, no agent list. */
  | 'lead-fresh-placeholder'
  /** A new session with `abc` typed, the cursor moved back to its start. */
  | 'lead-fresh-draft'
  /** Three agents running, the lead's input focused and empty. */
  | 'lead-input-empty'
  /** ↓ from the empty input: the pointer on `main`. */
  | 'lead-list-main'
  /** ↓ again: the pointer on the golf agent. */
  | 'lead-list-golf'
  /** Enter: golf's view, the list still focused on its row. */
  | 'view-golf-list'
  /** The view of the agent whose long description the rule label cuts short. */
  | 'view-long-list'
  /** ↑ to `main` in that view. */
  | 'view-long-list-main'
  /** Enter on `main`: the lead's view, the list still focused on `main`. */
  | 'lead-back-list-main'
  /** Golf's view with `x` typed: the input has the focus (rows show activity summaries). */
  | 'view-golf-draft'
  /** The same with the `x` erased: the placeholder alone. */
  | 'view-golf-input-empty'
  | 'unrecognised'

/** The fixture file of one screen. */
export function agentConsoleScreenFile(name: AgentConsoleScreenName): string {
  return join(AGENT_CONSOLE_SCREENS, `console-${name}.json`)
}

/** One fixture screen, row by row. */
export function agentConsoleScreen(name: AgentConsoleScreenName): string[] {
  const parsed = JSON.parse(readFileSync(agentConsoleScreenFile(name), 'utf8')) as {
    rows: string[]
  }
  return [...parsed.rows]
}

/** `screen` with its input line replaced by `typed` (one or more lines), for a draft it never showed. */
export function withInput(screen: readonly string[], typed: readonly string[]): string[] {
  const prompt = screen.findIndex((row) => row.startsWith('❯') && !/[●◯]/.test(row))
  return [
    ...screen.slice(0, prompt),
    `❯ ${typed[0] ?? ''}`,
    ...typed.slice(1).map((line) => `  ${line}`),
    ...screen.slice(prompt + 1)
  ]
}
