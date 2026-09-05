import { describe, expect, it } from 'vitest'
import { PERMISSION_INPUT_MAX_CHARS, permissionInputLine } from './permissionSummary'

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
})
