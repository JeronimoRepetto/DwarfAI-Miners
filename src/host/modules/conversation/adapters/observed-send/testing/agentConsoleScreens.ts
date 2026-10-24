// The Claude Code 2.1.310 lead-terminal screens of fixtures/claude/observer/2.1.310
// (`console-<state>.json`, AMENDMENT-29), as the console reader hands them: one string per row of
// the visible window. The screens are reconstructed from the spike record (the folder's meta.json
// says how).
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const AGENT_CONSOLE_SCREENS = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../../../fixtures/claude/observer/2.1.310'
)

export type AgentConsoleScreenName =
  | 'lead-input-empty'
  | 'lead-input-draft'
  | 'lead-input-multiline-draft'
  | 'lead-list-main'
  | 'lead-list-echo'
  | 'lead-no-agents'
  | 'view-echo-list'
  | 'view-delta-list'
  | 'view-echo-draft'
  | 'view-echo-input-empty'
  | 'view-echo-list-main'
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
