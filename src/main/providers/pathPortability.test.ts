import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FakeFs } from '../adapters/fakeFs'
import { defaultConfig } from '../config/config'
import { expandHomePath } from '../runtime/runtime'
import { ClaudeProvider } from './claude/claudeProvider'
import { CodexProvider } from './codex/codexProvider'
import { opencodeDbPath, opencodeWalPath } from './opencode/store'

/**
 * Provider directory walking used to concatenate `\` by hand, which made every
 * path this app builds Windows-only. These tests pin the fix from the outside:
 * the same provider, given a POSIX-style root and POSIX-style files, must
 * discover exactly what it discovers from a Windows root — and must do so on
 * whichever host runs the suite, which is why every expectation goes through
 * node:path.join rather than a hard-coded separator.
 */

const CLAUDE_FIXTURES = join(import.meta.dirname, '__fixtures__', 'claude')
const parentTranscript = readFileSync(join(CLAUDE_FIXTURES, 'parent-transcript.jsonl'), 'utf8')
const subagentTranscript = readFileSync(join(CLAUDE_FIXTURES, 'subagent-transcript.jsonl'), 'utf8')

const CODEX_FIXTURES = join(import.meta.dirname, '__fixtures__', 'codex')
const rollout = readFileSync(join(CODEX_FIXTURES, 'rollout.jsonl'), 'utf8')

const SESSION_ID = '5efdffdd-53df-4509-b30d-c9e56552a22e'
/** The one agent in the fixture transcript that is still in flight. */
const AGENT_ID = 'a34eaebecc3d57381'
const CODEX_SESSION_ID = '01a048b5-5f35-7312-ab78-38db464920de'
const NOW = new Date(2026, 7, 29, 12, 0, 0).getTime()

function claudeSessionEntry(cwd: string): string {
  return JSON.stringify({
    pid: 4242,
    sessionId: SESSION_ID,
    cwd,
    status: 'busy',
    kind: 'interactive',
    name: 'sample-project-70'
  })
}

/**
 * One Claude root laid out with `sep` as its separator, plus the encoded
 * project directory Claude Code would create for `cwd`.
 */
function claudeFixture(root: string, cwd: string, encoded: string, sep: string) {
  const fs = new FakeFs()
  fs.addFile(`${root}${sep}sessions${sep}4242.json`, claudeSessionEntry(cwd))
  fs.addFile(
    `${root}${sep}projects${sep}${encoded}${sep}${SESSION_ID}.jsonl`,
    parentTranscript,
    1_000
  )
  fs.addFile(
    `${root}${sep}projects${sep}${encoded}${sep}${SESSION_ID}${sep}subagents${sep}agent-${AGENT_ID}.jsonl`,
    subagentTranscript
  )
  return new ClaudeProvider({ fs, roots: [root], isPidAlive: () => true, now: () => NOW })
}

describe('ClaudeProvider path building', () => {
  const windows = claudeFixture(
    'C:\\Users\\j\\.claude',
    'C:\\Users\\j\\Desktop\\Sample-Project',
    'C--Users-j-Desktop-Sample-Project',
    '\\'
  )
  const posix = claudeFixture(
    '/home/j/.claude',
    '/home/j/projects/sample-project',
    '-home-j-projects-sample-project',
    '/'
  )

  it('discovers the same crew from a POSIX root as from a Windows root', async () => {
    const [fromWindows] = await windows.scan()
    const [fromPosix] = await posix.scan()
    expect(fromWindows?.dwarfs.map((dwarf) => dwarf.id)).toEqual(
      fromPosix?.dwarfs.map((dwarf) => dwarf.id)
    )
    expect(fromPosix?.dwarfs.length).toBeGreaterThan(1)
  })

  it('reaches the session transcript under a POSIX root', async () => {
    await posix.scan()
    expect(posix.transcriptPath(`claude:${SESSION_ID}`)).toBe(
      join('/home/j/.claude', 'projects', '-home-j-projects-sample-project', `${SESSION_ID}.jsonl`)
    )
    expect(await posix.feed(`claude:${SESSION_ID}`, 5)).not.toEqual([])
  })

  it('reaches a subagent transcript under a POSIX root', async () => {
    await posix.scan()
    const workerId = `claude:${SESSION_ID}:${AGENT_ID}`
    expect(posix.transcriptPath(workerId)).toBe(
      join(
        '/home/j/.claude',
        'projects',
        '-home-j-projects-sample-project',
        SESSION_ID,
        'subagents',
        `agent-${AGENT_ID}.jsonl`
      )
    )
    // A subagent whose transcript could not be reached would report no last
    // message at all, which is exactly what the hand-built `\` paths did.
    const worker = (await posix.scan())[0]?.dwarfs.find((dwarf) => dwarf.id === workerId)
    expect(worker?.lastMessage).toBeTruthy()
  })
})

function codexFixture(root: string, sep: string): CodexProvider {
  const fs = new FakeFs()
  // The rollout's own date directory: 2026/08/28, one day before NOW.
  fs.addFile(
    `${root}${sep}2026${sep}08${sep}28${sep}rollout-2026-08-28T14-10-45.jsonl`,
    rollout,
    NOW
  )
  return new CodexProvider({
    fs,
    sessionsRoot: root,
    livenessWindowS: 600,
    scanDays: 7,
    idleRetentionS: 0,
    now: () => NOW,
    isCodexProcessRunning: async () => false
  })
}

describe('CodexProvider path building', () => {
  it('walks the YYYY/MM/DD day directories under a POSIX sessions root', async () => {
    const posix = codexFixture('/home/j/.codex/sessions', '/')
    const snapshots = await posix.scan()
    expect(snapshots.map((snapshot) => snapshot.sessionId)).toEqual([CODEX_SESSION_ID])
  })

  it('discovers the same session from a Windows sessions root', async () => {
    const windows = codexFixture('C:\\Users\\j\\.codex\\sessions', '\\')
    const snapshots = await windows.scan()
    expect(snapshots.map((snapshot) => snapshot.sessionId)).toEqual([CODEX_SESSION_ID])
  })

  it('resolves a rollout it discovered by walking, under a POSIX root', async () => {
    const posix = codexFixture('/home/j/.codex/sessions', '/')
    await posix.scan()
    expect(posix.transcriptPath(`codex:${CODEX_SESSION_ID}`)).toBe(
      join('/home/j/.codex/sessions', '2026', '08', '28', 'rollout-2026-08-28T14-10-45.jsonl')
    )
  })
})

/*
 * Issue #444. OpenCode has no per-OS branch at all — no Platform parameter,
 * no directory walk — so its own path surface is exactly the two pure
 * builders `store.ts` exports. Pinned here alongside Claude's and Codex's own
 * cases so a future edit to either builder is caught by the same suite.
 */
describe('OpenCodeProvider path building', () => {
  // AMENDED (#453, WARNING 4): both cases ran GREEN on first run against
  // 2.2's already-correct builders — pins against future edits, stated as
  // such, rather than titled as if they drove the implementation.
  it('pins opencode.db and opencode.db-wal built from a POSIX root', () => {
    const root = '/home/j/.local/share/opencode'
    expect(opencodeDbPath(root)).toBe(join(root, 'opencode.db'))
    expect(opencodeWalPath(root)).toBe(join(root, 'opencode.db-wal'))
  })

  it('pins the same pair built from a Windows root', () => {
    const root = 'C:\\Users\\j\\.local\\share\\opencode'
    expect(opencodeDbPath(root)).toBe(join(root, 'opencode.db'))
    expect(opencodeWalPath(root)).toBe(join(root, 'opencode.db-wal'))
  })

  /*
   * DET-R1 ("The default shape is the same on every OS"): config.test.ts
   * pins the unexpanded default string; this expands it with a FIXED home
   * through the real expandHomePath, asserted via node:path.join like every
   * case above, so the same expectation holds whichever host runs the suite
   * — proving the expansion itself rather than only the string before it.
   */
  it('expands the default OpenCode store root identically, given a fixed home', () => {
    const home = '/home/j'
    expect(expandHomePath(defaultConfig().providers.opencode.storeRoot, home)).toBe(
      join(home, '.local', 'share', 'opencode')
    )
  })
})
