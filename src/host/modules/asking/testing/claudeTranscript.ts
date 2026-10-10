// Synthetic Claude Code transcript lines for the observed-Claude keystroke tests (ISSUE-134), in
// the record shapes of fixtures/claude/hook-keystroke/2.1.x. Never imported by production code
// (R14).

/** An assistant record with one `tool_use` call of the main session. */
export function toolUseLine(
  id: string,
  name = 'Bash',
  version = '2.1.261',
  input: Record<string, unknown> = { command: 'pnpm test' }
): string {
  return JSON.stringify({
    type: 'assistant',
    isSidechain: false,
    version,
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] }
  })
}

/** A user record with the `tool_result` that resolves the call `id`. */
export function toolResultLine(id: string, version = '2.1.261'): string {
  return JSON.stringify({
    type: 'user',
    isSidechain: false,
    version,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }
  })
}

/** Lines joined as a JSONL tail. */
export function transcript(...lines: string[]): string {
  return lines.map((line) => `${line}\n`).join('')
}
