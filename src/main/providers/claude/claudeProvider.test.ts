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

const parentLines = parentTranscript.split('\n').filter(Boolean)

/** Transcript slice where the only launched agent already completed (busy, no subagents). */
const noAgentTranscript = parentLines.slice(0, 6).join('\n') + '\n'

/**
 * The same agent's launch record with its completion notification no longer in
 * the window — exactly what a 256KiB tail read returns once a busy session has
 * written enough to push the notification out. This is the ghost-dwarf shape.
 */
const scrolledTailTranscript = parentLines.slice(0, 4).join('\n') + '\n'

const FINISHED_AGENT = 'a5d803981d4c3340f'
const LIVE_AGENT = 'a34eaebecc3d57381'

/** A `<task-notification>` line as Claude enqueues it when an agent stops. */
function notification(agentId: string, status: string): string {
  return (
    JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content:
          `<task-notification>\n<task-id>${agentId}</task-id>\n` +
          `<status>${status}</status>\n</task-notification>`
      }
    }) + '\n'
  )
}

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

  it('keeps the main session dwarf a foreman even with no subagents', async () => {
    // The main session is the orchestrator whether or not it currently has
    // agents out. Flipping its role would read as a different dwarf arriving.
    fake.addFile(`${ROOT1}\\projects\\${ENCODED}\\${SESSION_ID}.jsonl`, noAgentTranscript, 42_000)
    const snapshots = await makeProvider().scan()
    expect(snapshots[0]!.dwarfs).toHaveLength(1)
    expect(snapshots[0]!.dwarfs[0]).toMatchObject({
      id: `claude:${SESSION_ID}`,
      role: 'foreman',
      status: 'working'
    })
  })

  it('keeps the main dwarf identical when its last agent finishes', async () => {
    const provider = makeProvider()
    const withAgent = (await provider.scan())[0]!.dwarfs[0]!
    fake.addFile(`${ROOT1}\\projects\\${ENCODED}\\${SESSION_ID}.jsonl`, noAgentTranscript, 43_000)
    const alone = (await provider.scan())[0]!.dwarfs[0]!
    expect(alone.id).toBe(withAgent.id)
    expect(alone.role).toBe(withAgent.role)
  })

  describe('tokensObserved', () => {
    it('reports the foreman and worker tokensObserved from their transcript tails', async () => {
      const snapshots = await makeProvider().scan()
      const [foreman, worker] = snapshots[0]!.dwarfs
      // Parent's last assistant line: 2+517+616+116448 = 117583.
      expect(foreman!.tokensObserved).toBe(117_583)
      // Subagent's only assistant line: 2+1152+7879+117478 = 126511.
      expect(worker!.tokensObserved).toBe(126_511)
    })

    it('never decreases across polls even if a later tail reads a smaller usage block', async () => {
      const provider = makeProvider()
      const first = (await provider.scan())[0]!.dwarfs[0]!
      expect(first.tokensObserved).toBe(117_583)

      // Same transcript again — a context reset would report smaller numbers,
      // but the runtime-lifetime counter must never go backwards.
      const smallerUsage =
        JSON.stringify({
          type: 'assistant',
          message: {
            model: 'claude-fable-5',
            role: 'assistant',
            content: [{ type: 'text', text: 'after reset' }],
            usage: { input_tokens: 1, output_tokens: 1 }
          }
        }) + '\n'
      fake.addFile(`${ROOT1}\\projects\\${ENCODED}\\${SESSION_ID}.jsonl`, smallerUsage, 50_000)
      const second = (await provider.scan())[0]!.dwarfs[0]!
      expect(second.tokensObserved).toBe(117_583)
    })

    it('raises the running total when a later poll observes more usage than before', async () => {
      const provider = makeProvider()
      const first = (await provider.scan())[0]!.dwarfs[0]!
      expect(first.tokensObserved).toBe(117_583)

      // A later turn whose usage block is bigger than everything seen so far
      // (conversation kept growing) must raise the running total to match.
      const moreUsage =
        parentTranscript +
        JSON.stringify({
          type: 'assistant',
          message: {
            model: 'claude-fable-5',
            role: 'assistant',
            content: [{ type: 'text', text: 'more work' }],
            usage: { input_tokens: 1, output_tokens: 200_000 }
          }
        }) +
        '\n'
      fake.addFile(`${ROOT1}\\projects\\${ENCODED}\\${SESSION_ID}.jsonl`, moreUsage, 50_000)
      const second = (await provider.scan())[0]!.dwarfs[0]!
      expect(second.tokensObserved).toBe(200_001)
    })
  })

  it('leaves a waiting main session a foreman too', async () => {
    fake.addFile(
      `${ROOT1}\\sessions\\32896.json`,
      JSON.stringify({ ...JSON.parse(sessionEntry), status: 'idle' }),
      1_000
    )
    const snapshots = await makeProvider().scan()
    expect(snapshots[0]!.dwarfs[0]).toMatchObject({ role: 'foreman', status: 'waiting' })
  })

  describe('finished agents', () => {
    it('drops an agent killed by an accidental stop', async () => {
      fake.addFile(
        `${ROOT1}\\projects\\${ENCODED}\\${SESSION_ID}.jsonl`,
        parentTranscript + notification(LIVE_AGENT, 'killed'),
        42_000
      )
      const snapshots = await makeProvider().scan()
      expect(snapshots[0]!.dwarfs.map((dwarf) => dwarf.id)).toEqual([`claude:${SESSION_ID}`])
    })

    it('shows an agent whose launch record is all this provider has ever seen', async () => {
      fake.addFile(
        `${ROOT1}\\projects\\${ENCODED}\\${SESSION_ID}.jsonl`,
        scrolledTailTranscript,
        42_000
      )
      const snapshots = await makeProvider().scan()
      expect(snapshots[0]!.dwarfs.map((dwarf) => dwarf.id)).toEqual([
        `claude:${SESSION_ID}`,
        `claude:${SESSION_ID}:${FINISHED_AGENT}`
      ])
    })

    it('never re-lists an agent whose completion scrolled out of the tail', async () => {
      const provider = makeProvider()
      // Poll one still has the completion notification in the window.
      fake.addFile(`${ROOT1}\\projects\\${ENCODED}\\${SESSION_ID}.jsonl`, noAgentTranscript, 42_000)
      expect((await provider.scan())[0]!.dwarfs).toHaveLength(1)

      // Poll two only reaches back as far as the launch record.
      fake.addFile(
        `${ROOT1}\\projects\\${ENCODED}\\${SESSION_ID}.jsonl`,
        scrolledTailTranscript,
        43_000
      )
      const second = await provider.scan()
      expect(second[0]!.dwarfs.map((dwarf) => dwarf.id)).toEqual([`claude:${SESSION_ID}`])
    })

    it('remembers a killed agent across polls as well', async () => {
      const provider = makeProvider()
      fake.addFile(
        `${ROOT1}\\projects\\${ENCODED}\\${SESSION_ID}.jsonl`,
        parentTranscript + notification(LIVE_AGENT, 'killed'),
        42_000
      )
      await provider.scan()
      fake.addFile(`${ROOT1}\\projects\\${ENCODED}\\${SESSION_ID}.jsonl`, parentTranscript, 43_000)
      const second = await provider.scan()
      expect(second[0]!.dwarfs.map((dwarf) => dwarf.id)).toEqual([`claude:${SESSION_ID}`])
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

  /**
   * Regression (issue #12): scan() used to clear() the shared feedSources map
   * and repopulate it across awaits, so a click landing mid-scan read a
   * half-rebuilt map — observed once as the first activation after boot
   * resolving another dwarf's transcript. The map must be built off to the
   * side and swapped in atomically at the end of the scan.
   */
  describe('feed sources during a concurrent scan', () => {
    /** Suspends the next transcript read and resolves once the scan is parked there. */
    function gateNextTranscriptRead(): { reached: Promise<void>; release: () => void } {
      let release!: () => void
      let markReached!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const reached = new Promise<void>((resolve) => {
        markReached = resolve
      })
      fake.onBeforeRead = async (path) => {
        if (!path.endsWith('.jsonl')) return
        fake.onBeforeRead = undefined
        markReached()
        await gate
      }
      return { reached, release }
    }

    it('keeps the previous scan resolvable while the next scan is in flight', async () => {
      const provider = makeProvider()
      await provider.scan()
      const mainId = `claude:${SESSION_ID}`
      const settled = provider.transcriptPath(mainId)
      expect(settled).toBe(`${ROOT1}\\projects\\${ENCODED}\\${SESSION_ID}.jsonl`)

      const gate = gateNextTranscriptRead()
      const scanning = provider.scan()
      await gate.reached

      expect(provider.transcriptPath(mainId)).toBe(settled)
      expect((await provider.feed(mainId, 20))!.length).toBeGreaterThan(0)

      gate.release()
      await scanning
      expect(provider.transcriptPath(mainId)).toBe(settled)
    })

    it('never resolves a dwarf id to another dwarf transcript mid-scan', async () => {
      const provider = makeProvider()
      await provider.scan()
      const workerId = `claude:${SESSION_ID}:${LIVE_AGENT}`
      const workerPath = provider.transcriptPath(workerId)
      expect(workerPath).toContain(`agent-${LIVE_AGENT}.jsonl`)

      const gate = gateNextTranscriptRead()
      const scanning = provider.scan()
      await gate.reached

      // Whatever the in-flight scan is doing, a worker id must never come back
      // pointing at the parent transcript (or any other dwarf's file).
      expect(provider.transcriptPath(workerId)).toBe(workerPath)

      gate.release()
      await scanning
    })
  })

  describe('textDelivery', () => {
    it('has no channel before the first scan or for an unknown dwarf', async () => {
      const provider = makeProvider()
      expect(provider.textDelivery(`claude:${SESSION_ID}`)).toBeNull()
      await provider.scan()
      expect(provider.textDelivery('claude:nobody')).toBeNull()
    })

    it('types into the console of an interactive session', async () => {
      const provider = makeProvider()
      await provider.scan()
      expect(provider.textDelivery(`claude:${SESSION_ID}`)).toEqual({
        kind: 'terminal',
        pid: 32896
      })
    })

    it('relays to a headless background session by its registry name', async () => {
      fake.addFile(
        `${ROOT1}\\sessions\\32896.json`,
        JSON.stringify({
          pid: 32896,
          sessionId: SESSION_ID,
          cwd: CWD,
          status: 'busy',
          kind: 'bg',
          name: 'ai-tools-70'
        }),
        1_000
      )
      const provider = makeProvider()
      await provider.scan()
      expect(provider.textDelivery(`claude:${SESSION_ID}`)).toEqual({
        kind: 'claude-relay',
        sessionName: 'ai-tools-70'
      })
    })

    it('routes a subagent worker through its foreman', async () => {
      const provider = makeProvider()
      await provider.scan()
      const target = provider.textDelivery(`claude:${SESSION_ID}:${LIVE_AGENT}`)
      expect(target).toMatchObject({
        kind: 'foreman-relay',
        foremanDwarfId: `claude:${SESSION_ID}`
      })
    })

    it('drops the channel of a session that is gone by the next scan', async () => {
      const provider = makeProvider()
      await provider.scan()
      expect(provider.textDelivery(`claude:${SESSION_ID}`)).not.toBeNull()

      alivePids.clear()
      await provider.scan()
      expect(provider.textDelivery(`claude:${SESSION_ID}`)).toBeNull()
    })
  })
})
