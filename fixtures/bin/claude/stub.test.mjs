// layer: L7
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { playStub, USAGE_EXIT } from '../_kit/stubCli.mjs'
import { claudeScriptFor } from './claude.mjs'

/**
 * `StubClaudeCli` for the stream-json driver (ISSUE-150; testing strategy `17` §1.9): a `claude -p`
 * stream-json run replays the recorded S-020-1 readiness turn (Claude Code 2.1.301) on stdout byte
 * for byte, and `--help` prints the recorded 2.1.301 help (SP-08), so an L9 flow drives `ClaudeStreamJsonDriver` against the same bytes
 * its conformance run reads. Every other run of the stub is unchanged (the transcript scripts of the
 * observed path).
 */

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const STREAM = [
  '-p',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--verbose'
]

let tempDirs = []

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs = []
})

/** A script file in its own mkdtemp directory. */
function writeTemp(script) {
  const dir = mkdtempSync(path.join(tmpdir(), 'stub-claude-'))
  tempDirs.push(dir)
  const file = path.join(dir, 'script.json')
  writeFileSync(file, JSON.stringify(script))
  return file
}

const play = (argv, env = {}) =>
  playStub({
    name: 'claude',
    homeEnv: 'CLAUDE_CONFIG_DIR',
    defaultScript: claudeScriptFor(argv),
    argv,
    env
  })

describe('StubClaudeCli stream-json replay (ISSUE-150)', () => {
  it('[C-05] the Claude stub replays the simple-turn fixture byte for byte', () => {
    const run = play([...STREAM, '--session-id', '00000000-0000-7000-8000-000000000001'])
    const fixture = path.join(FIXTURES, 'claude', 'stream-json', '2.1.x', 's0201-readiness.jsonl')
    expect(run.exitCode).toBe(0)
    expect(Buffer.from(run.stdout, 'utf8').equals(readFileSync(fixture))).toBe(true)
  })

  it('[C-26, SP-08] the Claude stub answers --help with the probe fixture and writes nothing', () => {
    const run = play(['--help'])
    const fixture = path.join(
      FIXTURES,
      'claude',
      'stream-json',
      '2.1.x',
      'probe-help-without-prompt-tool.jsonl'
    )
    expect(run.exitCode).toBe(0)
    expect(run.stdout).toBe(readFileSync(fixture, 'utf8'))
    // SP-08: 2.1.301 names the flag only inside the --permission-prompts description.
    expect(run.stdout).toMatch(/--permission-prompts <target>[\s\S]*?--permission-prompt-tool\)/)
  })

  it('[ADR-008] a run without -p keeps the transcript script of the observed path', () => {
    expect(claudeScriptFor([])).toBe('claude-session-one-turn')
    expect(claudeScriptFor(['--version'])).toBe('claude-session-one-turn')
    expect(claudeScriptFor(STREAM)).toBe('claude-stream-json-simple-turn')
    expect(claudeScriptFor(['--help'])).toBe('claude-stream-json-simple-turn')
  })

  it('[ADR-008] a stdout fixture outside fixtures/ is refused before anything is printed', () => {
    const script = path.join(
      FIXTURES,
      'bin',
      '_kit',
      'scripts',
      'claude-stream-json-simple-turn.json'
    )
    const outside = {
      ...JSON.parse(readFileSync(script, 'utf8')),
      replay: [{ stdout: '../package.json' }]
    }
    const run = playStub({
      name: 'claude',
      homeEnv: 'CLAUDE_CONFIG_DIR',
      defaultScript: 'claude-stream-json-simple-turn',
      argv: STREAM,
      env: { DWARFAI_STUB_CLAUDE_SCRIPT: writeTemp(outside) }
    })
    expect(run.exitCode).toBe(USAGE_EXIT)
    expect(run.stdout).toBe('')
  })
})
