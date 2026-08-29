import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { FakeFs } from '../../adapters/fakeFs'
import { ClaudeProvider } from './claudeProvider'

const FIXTURES = join(import.meta.dirname, '..', '__fixtures__', 'claude')
const parentTranscript = readFileSync(join(FIXTURES, 'parent-transcript.jsonl'), 'utf8')
const subagentTranscript = readFileSync(join(FIXTURES, 'subagent-transcript.jsonl'), 'utf8')
const sessionEntry = readFileSync(join(FIXTURES, 'session-entry.json'), 'utf8')

const ROOT1 = 'C:\\Users\\jeron\\.claude'
const ROOT2 = 'C:\\Users\\jeron\\.claude-multitec'
const MISSING_ROOT = 'C:\\Users\\jeron\\.claude-ghost'
const SESSION_ID = '5efdffdd-53df-4509-b30d-c9e56552a22e'
const CWD = 'C:\\Users\\jeron\\Desktop\\AI-Tools'
const ENCODED = 'C--Users-jeron-Desktop-AI-Tools'

/** Transcript slice where the only launched agent already completed (busy, no subagents). */
const noAgentTranscript = parentTranscript.split('\n').filter(Boolean).slice(0, 6).join('\n') + '\n'

function otherEntry(pid: number, sessionId: string, cwd: string, status: string): string {
  return JSON.stringify({ pid, sessionId, cwd, status, name: 'other-1', updatedAt: 5_000 })
}

describe('ClaudeProvider', () => {
  let fake: FakeFs
  let alivePids: Set<number>

  function makeProvider(roots = [ROOT1, ROOT2, MISSING_ROOT]): ClaudeProvider {
    return new ClaudeProvider({
      fs: fake,
      roots,
      isPidAlive: (pid) => alivePids.has(pid),
      now: () => 99_000
    })
  }

  beforeEach(() => {
    fake = new FakeFs()
    alivePids = new Set([32896])
    fake.addFile(`${ROOT1}\\sessions\\32896.json`, sessionEntry, 1_000)
    fake.addFile(`${ROOT1}\\sessions\\32896.abcdef.key`, 'not json', 1_000)
    fake.addFile(`${ROOT1}\\projects\\${ENCODED}\\${SESSION_ID}.jsonl`, parentTranscript, 42_000)
    fake.addFile(
      `${ROOT1}\\projects\\${ENCODED}\\${SESSION_ID}\\subagents\\agent-a34eaebecc3d57381.jsonl`,
      subagentTranscript,
      43_000
    )
  })

  it('has kind claude', () => {
    expect(makeProvider().kind).toBe('claude')
  })

  it('maps a busy session with an in-flight agent to a foreman plus a worker', async () => {
    const snapshots = await makeProvider().scan()
    expect(snapshots).toHaveLength(1)
    const snapshot = snapshots[0]!
    expect(snapshot.provider).toBe('claude')
    expect(snapshot.sessionId).toBe(SESSION_ID)
    expect(snapshot.cwd).toBe(CWD)
    expect(snapshot.status).toBe('busy')
    expect(snapshot.updatedAt).toBe(42_000)
    expect(snapshot.dwarfs).toHaveLength(2)

    const [foreman, worker] = snapshot.dwarfs
    expect(foreman).toMatchObject({
      id: `claude:${SESSION_ID}`,
      provider: 'claude',
      role: 'foreman',
      name: 'ai-tools-70',
      model: 'claude-fable-5',
      effort: 'xhigh',
      status: 'working',
      lastMessage: 'Latest assistant reply placeholder.',
      sessionId: SESSION_ID,
      pid: 32896,
      startedAt: 1788001972417
    })
    expect(worker).toMatchObject({
      id: `claude:${SESSION_ID}:a34eaebecc3d57381`,
      provider: 'claude',
      role: 'worker',
      name: 'Placeholder agent task',
      model: 'claude-fable-5',
      status: 'working',
      description: 'Placeholder agent task',
      lastMessage: 'Subagent latest reply placeholder.',
      sessionId: SESSION_ID
    })
  })

  it('maps a busy session without subagents to a single worker', async () => {
    fake.addFile(`${ROOT1}\\projects\\${ENCODED}\\${SESSION_ID}.jsonl`, noAgentTranscript, 42_000)
    const snapshots = await makeProvider().scan()
    expect(snapshots[0]!.dwarfs).toHaveLength(1)
    expect(snapshots[0]!.dwarfs[0]).toMatchObject({
      id: `claude:${SESSION_ID}`,
      role: 'worker',
      status: 'working'
    })
  })

  it('maps an idle session to a snapshot with no dwarfs', async () => {
    fake.addFile(
      `${ROOT2}\\sessions\\40000.json`,
      otherEntry(
        40000,
        'bbbbbbbb-0000-0000-0000-000000000000',
        'C:\\Users\\jeron\\Desktop\\Other',
        'idle'
      )
    )
    alivePids.add(40000)
    const snapshots = await makeProvider().scan()
    const idle = snapshots.find((s) => s.sessionId.startsWith('bbbb'))
    expect(idle).toBeDefined()
    expect(idle!.status).toBe('idle')
    expect(idle!.dwarfs).toEqual([])
    // no transcript on disk for it -> falls back to the registry updatedAt
    expect(idle!.updatedAt).toBe(5_000)
  })

  it('scans multiple config roots and skips missing ones', async () => {
    fake.addFile(
      `${ROOT2}\\sessions\\40000.json`,
      otherEntry(
        40000,
        'bbbbbbbb-0000-0000-0000-000000000000',
        'C:\\Users\\jeron\\Desktop\\Other',
        'busy'
      )
    )
    alivePids.add(40000)
    const snapshots = await makeProvider().scan()
    expect(snapshots.map((s) => s.sessionId).sort()).toEqual([
      SESSION_ID,
      'bbbbbbbb-0000-0000-0000-000000000000'
    ])
  })

  it('dedupes the same sessionId visible through two roots (projects junction)', async () => {
    fake.addFile(`${ROOT2}\\sessions\\32896.json`, sessionEntry, 1_000)
    const snapshots = await makeProvider().scan()
    expect(snapshots).toHaveLength(1)
  })

  it('skips sessions whose pid is no longer alive', async () => {
    alivePids.clear()
    expect(await makeProvider().scan()).toEqual([])
  })

  it('skips malformed registry entries without failing the scan', async () => {
    fake.addFile(`${ROOT1}\\sessions\\777.json`, '{"pid": "broken"}')
    const snapshots = await makeProvider().scan()
    expect(snapshots).toHaveLength(1)
  })

  it('still reports a busy session when the transcript file is missing', async () => {
    fake.removeFile(`${ROOT1}\\projects\\${ENCODED}\\${SESSION_ID}.jsonl`)
    const snapshots = await makeProvider().scan()
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]!.dwarfs).toHaveLength(1)
    expect(snapshots[0]!.dwarfs[0]!.model).toBeUndefined()
    expect(snapshots[0]!.updatedAt).toBe(1788003794280)
  })

  describe('feed', () => {
    it('returns the parent transcript feed for the main dwarf', async () => {
      const provider = makeProvider()
      await provider.scan()
      const feed = await provider.feed(`claude:${SESSION_ID}`, 20)
      expect(feed!.map((m) => m.text)).toEqual([
        'Placeholder user prompt.',
        'Placeholder text block.',
        'Latest assistant reply placeholder.'
      ])
    })

    it('returns the subagent transcript feed for a worker dwarf', async () => {
      const provider = makeProvider()
      await provider.scan()
      const feed = await provider.feed(`claude:${SESSION_ID}:a34eaebecc3d57381`, 20)
      expect(feed!.map((m) => m.text)).toEqual([
        'Placeholder user prompt.',
        'Subagent latest reply placeholder.'
      ])
    })

    it('returns null for an unknown dwarf id', async () => {
      const provider = makeProvider()
      await provider.scan()
      expect(await provider.feed('claude:nope', 20)).toBeNull()
    })
  })
})
