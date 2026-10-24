// The Claude Code 2.1.310 lead-terminal screens of fixtures/claude/console/2.1.310 (AMENDMENT-29),
// as the console reader hands them: one string per row of the visible window. The screens are
// reconstructed from the spike record (the fixture folder's meta.json says how).
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const AGENT_CONSOLE_SCREENS = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../../../fixtures/claude/console/2.1.310'
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

/** One fixture screen, row by row. */
export function agentConsoleScreen(name: AgentConsoleScreenName): string[] {
  return readFileSync(join(AGENT_CONSOLE_SCREENS, `${name}.txt`), 'utf8')
    .replace(/\n$/, '')
    .split('\n')
}
