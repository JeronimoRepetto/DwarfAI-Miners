import { describe, expect, it } from 'vitest'
import {
  ACTIVITY_VERBS,
  PERMISSION_INPUT_MAX_CHARS,
  permissionInputLine,
  toolActivityLine
} from './permissionSummary'

const FAKE_SK_KEY = ['sk', 'a'.repeat(48)].join('-')

describe('permissionInputLine', () => {
  it('names the command a shell tool wants to run', () => {
    expect(permissionInputLine({ command: 'pnpm test', description: 'run the suite' })).toBe(
      'pnpm test'
    )
  })

  it('reads the first recognised field in order, so a command beats a path', () => {
    expect(permissionInputLine({ file_path: '/some/file.ts', command: 'rm -rf build' })).toBe(
      'rm -rf build'
    )
  })

  it.each([
    ['file_path', { file_path: 'src/main/index.ts' }, 'src/main/index.ts'],
    ['path', { path: 'src/shared' }, 'src/shared'],
    ['url', { url: 'https://example.test/docs' }, 'https://example.test/docs'],
    ['pattern', { pattern: '**/*.test.ts' }, '**/*.test.ts']
  ])('reads %s when no command is present', (_field, input, expected) => {
    expect(permissionInputLine(input)).toBe(expected)
  })

  it('falls back to the whole input as JSON for a tool this table does not know', () => {
    expect(permissionInputLine({ server: 'atlas', ref: 42 })).toBe('{"server":"atlas","ref":42}')
  })

  it('ignores a recognised field that is not a string', () => {
    expect(permissionInputLine({ command: 12, path: 'src' })).toBe('src')
  })

  it('caps a pasted payload so it can never become the whole card', () => {
    const line = permissionInputLine({ command: 'x'.repeat(5_000) })
    expect(line.length).toBeLessThanOrEqual(PERMISSION_INPUT_MAX_CHARS)
  })

  it('redacts a secret sitting inside the command', () => {
    expect(permissionInputLine({ command: `curl -H "auth: ${FAKE_SK_KEY}" example.test` })).toBe(
      'curl -H "auth: [redacted]" example.test'
    )
  })

  /**
   * The cap runs BEFORE redaction, which is only safe because redactSecrets
   * matches a truncated key too — see its own module comment on why a prefix
   * of a key is still a key. Pinned here so a reordering that looked harmless
   * cannot ship a half-key.
   */
  it('redacts a key the cap cut in half', () => {
    const line = permissionInputLine({ command: `${'x'.repeat(200)} ${FAKE_SK_KEY}` })
    expect(line).not.toContain('sk-aaaa')
    expect(line).toContain('[redacted]')
  })

  /**
   * #240 moved `pattern` ahead of `path`. Grep is the one tool observed
   * carrying both (2022 of 2080 calls in the corpus §1.6 tabulates), and the
   * design's own `Searched <pattern>` settles which of the two names the call.
   * The card gains the same reading, because there is one rule.
   */
  it('names the pattern rather than the directory when a tool carries both', () => {
    expect(permissionInputLine({ path: 'src', pattern: 'FeedMessage' })).toBe('FeedMessage')
  })
})

/**
 * The same rule spoken as the line a call leaves behind once it has run
 * (#240). One table serves the card and the feed, so a tool call reads the
 * same before and after — which is the whole reason this lives here rather
 * than in the three extractors that call it.
 */
describe('toolActivityLine', () => {
  it.each([
    ['Edit', { file_path: 'src/main/index.ts' }, 'edit', 'Edited src/main/index.ts'],
    ['Write', { file_path: 'src/shared/contracts.ts' }, 'edit', 'Edited src/shared/contracts.ts'],
    ['NotebookEdit', { path: 'notes.ipynb' }, 'edit', 'Edited notes.ipynb'],
    ['Bash', { command: 'pnpm test' }, 'run', 'Ran pnpm test'],
    ['PowerShell', { command: 'Get-Process' }, 'run', 'Ran Get-Process'],
    ['Read', { file_path: 'AGENTS.md' }, 'read', 'Read AGENTS.md'],
    ['WebFetch', { url: 'https://example.test/docs' }, 'read', 'Read https://example.test/docs'],
    ['Grep', { pattern: 'FeedMessage', path: 'src' }, 'search', 'Searched FeedMessage'],
    ['Glob', { pattern: '**/*.test.ts' }, 'search', 'Searched **/*.test.ts'],
    ['shell_command', { command: 'git status' }, 'run', 'Ran git status'],
    ['apply_patch', { file_path: 'src/parse.ts' }, 'edit', 'Edited src/parse.ts'],
    // AMENDED for #280 (was: the it.each list ended at apply_patch). Antigravity
    // CLI rows, keyed by its own tool names, decoded by antigravity/parse.ts
    // before this table ever sees them — see its own `antigravityToolInput`.
    ['view_file', { file_path: 'src/parse.ts' }, 'read', 'Read src/parse.ts'],
    ['list_dir', { path: 'src' }, 'read', 'Read src'],
    ['run_command', { command: 'pnpm test' }, 'run', 'Ran pnpm test'],
    ['grep_search', { pattern: 'FeedMessage', path: 'src' }, 'search', 'Searched FeedMessage'],
    ['find_by_name', { pattern: '*.test.ts', path: 'src' }, 'search', 'Searched *.test.ts'],
    ['write_to_file', { file_path: 'scratch/note.md' }, 'edit', 'Edited scratch/note.md'],
    ['replace_file_content', { file_path: 'src/parse.test.ts' }, 'edit', 'Edited src/parse.test.ts']
  ])('speaks a %s call as one line', (toolName, input, kind, text) => {
    expect(toolActivityLine(toolName, input)).toEqual({
      role: 'assistant',
      text,
      activity: { kind, target: text.slice(text.indexOf(' ') + 1) }
    })
  })

  /**
   * `role: 'assistant'` and a `text` that reads as a sentence are what keep an
   * older reader honest: it draws the line as something the agent did rather
   * than as an empty bubble (see FeedMessage.activity).
   */
  it('is an assistant turn whose text stands on its own without the activity field', () => {
    const line = toolActivityLine('Bash', { command: 'pnpm test' })
    expect(line?.role).toBe('assistant')
    expect(line?.text).toBe('Ran pnpm test')
  })

  it.each([
    ['a tool no verb is known for', 'Agent', { description: 'survey the seam' }],
    ['an MCP tool', 'mcp__engram__mem_save', { content: 'note' }],
    ['the one tool that asks instead of acting', 'AskUserQuestion', { questions: [] }],
    ['a known tool whose input names no subject', 'Bash', { timeout: 5 }],
    ['a known tool whose subject is not a string', 'Read', { file_path: 42 }],
    ['a known tool whose subject is only whitespace', 'Bash', { command: '   ' }],
    // AMENDED for #280 (was: the it.each list ended at "only whitespace").
    // Antigravity tools this table deliberately omits, one per omission kind
    // TOOL_ACTIVITY_KINDS's own comment gives.
    ['Antigravity agent management, drawn as a dwarf already', 'manage_subagents', { path: 'x' }],
    ['an Antigravity subagent launch, drawn as a dwarf already', 'invoke_subagent', { path: 'x' }],
    ['the Antigravity agent scheduling a wakeup rather than acting', 'schedule', { command: 'x' }],
    ['an Antigravity MCP call with no subject this table names', 'call_mcp_tool', { path: 'x' }]
  ])('answers nothing for %s', (_case, toolName, input) => {
    expect(toolActivityLine(toolName, input)).toBeUndefined()
  })

  /**
   * The design asks for ONE line, truncated at the panel width. A heredoc or a
   * multi-line patch would otherwise put its own newlines into a row that
   * cannot show them.
   */
  it('collapses a multi-line command into one line', () => {
    expect(toolActivityLine('Bash', { command: 'git commit -m "one\n\n  two"' })?.text).toBe(
      'Ran git commit -m "one two"'
    )
  })

  it('caps the target exactly where the card caps it', () => {
    const line = toolActivityLine('Bash', { command: 'x'.repeat(5_000) })
    expect(line?.activity?.target.length).toBe(PERMISSION_INPUT_MAX_CHARS)
  })

  it('redacts a secret in the line and in the target it carries', () => {
    const line = toolActivityLine('Bash', { command: `curl -H "auth: ${FAKE_SK_KEY}" x.test` })
    expect(line?.text).toBe('Ran curl -H "auth: [redacted]" x.test')
    expect(line?.activity?.target).not.toContain('sk-aaaa')
  })

  it('spells each verb once, so the card and the feed cannot drift apart', () => {
    expect(ACTIVITY_VERBS).toEqual({
      edit: 'Edited',
      run: 'Ran',
      read: 'Read',
      search: 'Searched'
    })
  })
})
