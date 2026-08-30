import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Dwarf } from '../../../shared/contracts'
import { FakeFs } from '../../adapters/fakeFs'
import { ClaudeProvider } from './claudeProvider'

const FIXTURES = join(import.meta.dirname, '..', '__fixtures__', 'claude')
const parentTranscript = readFileSync(join(FIXTURES, 'parent-transcript.jsonl'), 'utf8')
const subagentTranscript = readFileSync(join(FIXTURES, 'subagent-transcript.jsonl'), 'utf8')
const sessionEntry = readFileSync(join(FIXTURES, 'session-entry.json'), 'utf8')

const ROOT1 = 'C:\\Users\\j\\.claude'
const ROOT2 = 'C:\\Users\\j\\.claude-work'
const MISSING_ROOT = 'C:\\Users\\j\\.claude-ghost'
const SESSION_ID = '5efdffdd-53df-4509-b30d-c9e56552a22e'
const CWD = 'C:\\Users\\j\\Desktop\\Sample-Project'
const ENCODED = 'C--Users-j-Desktop-Sample-Project'

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

/**
 * The same notification in the envelope Claude Code actually writes most of
 * them into: a `queue-operation` record, which carries no `message` key at all
 * (issue #64). See `__fixtures__/claude/notification-envelopes.jsonl`.
 */
function queuedNotification(agentId: string, status: string): string {
  return (
    JSON.stringify({
      type: 'queue-operation',
      operation: 'enqueue',
      timestamp: '2026-08-29T11:40:22.000Z',
      sessionId: SESSION_ID,
      content:
        `<task-notification>\n<task-id>${agentId}</task-id>\n` +
        `<status>${status}</status>\n</task-notification>`
    }) + '\n'
  )
}

/**
 * A Bash result that printed a transcript containing a notification. The blob
 * is identical; only the envelope says it is tool output rather than an ending.
 */
function quotedNotification(agentId: string, status: string): string {
  const blob =
    `<task-notification>\n<task-id>${agentId}</task-id>\n` +
    `<status>${status}</status>\n</task-notification>`
  return (
    JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { tool_use_id: 'toolu_0000000000000000000001', type: 'tool_result', content: blob }
        ]
      },
      toolUseResult: { stdout: blob, stderr: '', interrupted: false, isImage: false }
    }) + '\n'
  )
}

/**
 * An `async_launched` line as Claude writes it when a background agent starts,
 * reduced to the fields the parser actually reads. The fixture carries a full
 * real record; this builder exists to place a SECOND launch at a chosen depth
 * in a synthetic transcript, which no single fixture line can do.
 */
function launch(agentId: string, description: string): string {
  return (
    JSON.stringify({
      type: 'user',
      toolUseResult: {
        isAsync: true,
        status: 'async_launched',
        agentId,
        description,
        resolvedModel: 'claude-fable-5'
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
      name: 'sample-project-70',
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

  /**
   * Issue #34: the registry reports `waiting` (with an optional `waitingFor`
   * naming the condition, e.g. "dialog open") while a session is alive but
   * blocked on user input, a dialog, or a long tool. That structured signal —
   * never assistant text — is what turns the foreman's pickaxe off.
   */
  describe('blocked sessions (issue #34)', () => {
    const TRANSCRIPT = `${ROOT1}\\projects\\${ENCODED}\\${SESSION_ID}.jsonl`

    /** The fixture registry entry with its status (and optional waitingFor) replaced. */
    function entryWithStatus(status: string, waitingFor?: string): string {
      return JSON.stringify({
        ...JSON.parse(sessionEntry),
        status,
        ...(waitingFor !== undefined ? { waitingFor } : {})
      })
    }

    it('shows a waiting foreman when the registry reports a blocked session', async () => {
      // Real observed shape: {"status":"waiting","waitingFor":"dialog open"}.
      fake.addFile(
        `${ROOT1}\\sessions\\32896.json`,
        entryWithStatus('waiting', 'dialog open'),
        1_000
      )
      fake.addFile(TRANSCRIPT, noAgentTranscript, 42_000)
      const snapshots = await makeProvider().scan()
      expect(snapshots[0]!.status).toBe('waiting')
      expect(snapshots[0]!.dwarfs).toHaveLength(1)
      expect(snapshots[0]!.dwarfs[0]).toMatchObject({ role: 'foreman', status: 'waiting' })
    })

    it('shows the waiting foreman even when the registry names no waitingFor condition', async () => {
      fake.addFile(`${ROOT1}\\sessions\\32896.json`, entryWithStatus('waiting'), 1_000)
      fake.addFile(TRANSCRIPT, noAgentTranscript, 42_000)
      const snapshots = await makeProvider().scan()
      expect(snapshots[0]!.dwarfs[0]).toMatchObject({ role: 'foreman', status: 'waiting' })
    })

    it('transitions working -> waiting -> working promptly as the registry flips', async () => {
      const provider = makeProvider()
      fake.addFile(TRANSCRIPT, noAgentTranscript, 42_000)
      expect((await provider.scan())[0]!.dwarfs[0]!.status).toBe('working')

      // The blocking condition begins: the very next poll must show it.
      fake.addFile(
        `${ROOT1}\\sessions\\32896.json`,
        entryWithStatus('waiting', 'dialog open'),
        2_000
      )
      expect((await provider.scan())[0]!.dwarfs[0]!.status).toBe('waiting')

      // Input arrives, the session resumes: back to working on the next poll.
      fake.addFile(`${ROOT1}\\sessions\\32896.json`, sessionEntry, 3_000)
      expect((await provider.scan())[0]!.dwarfs[0]!.status).toBe('working')
    })

    it('keeps in-flight workers conservatively working while their session waits', async () => {
      // Transcript tails carry no structured per-subagent blocked signal, so a
      // worker never guesses from its parent's registry state: it stays working
      // until its own terminal notification (the issue's conservative rule).
      fake.addFile(
        `${ROOT1}\\sessions\\32896.json`,
        entryWithStatus('waiting', 'dialog open'),
        1_000
      )
      const snapshots = await makeProvider().scan()
      const [foreman, worker] = snapshots[0]!.dwarfs
      expect(foreman).toMatchObject({ role: 'foreman', status: 'waiting' })
      expect(worker).toMatchObject({ role: 'worker', status: 'working' })
    })

    it('keeps an idle session dwarfless — leaving behavior is unchanged', async () => {
      fake.addFile(`${ROOT1}\\sessions\\32896.json`, entryWithStatus('idle'), 1_000)
      fake.addFile(TRANSCRIPT, noAgentTranscript, 42_000)
      const snapshots = await makeProvider().scan()
      expect(snapshots[0]!.status).toBe('idle')
      expect(snapshots[0]!.dwarfs).toEqual([])
    })
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

    /**
     * Regression (issue #64). Measured against a real 2.4 MB session: ten
     * subagents launched, all ten notified, and the provider retired two. The
     * eight it missed had notified through `queue-operation` and `attachment`
     * records, which carry no `message.content` for the scan to be rooted at,
     * so the ending signal never fired and the foreman accumulated ghosts.
     */
    it('drops an agent whose notification only ever arrived as a queue-operation', async () => {
      fake.addFile(
        `${ROOT1}\\projects\\${ENCODED}\\${SESSION_ID}.jsonl`,
        parentTranscript + queuedNotification(LIVE_AGENT, 'completed'),
        42_000
      )
      const snapshots = await makeProvider().scan()
      expect(snapshots[0]!.dwarfs.map((dwarf) => dwarf.id)).toEqual([`claude:${SESSION_ID}`])
    })

    /**
     * The other half of that fix, and the one that must never regress: reading
     * the envelope wider is not the same as reading every string. A live agent
     * whose notification a tool merely printed is #60's waiting agent, and
     * `terminalAgentIds` is remembered for the life of the process, so retiring
     * it here would keep it retired everywhere.
     */
    it('keeps an agent mining when a tool result merely printed its notification', async () => {
      fake.addFile(
        `${ROOT1}\\projects\\${ENCODED}\\${SESSION_ID}.jsonl`,
        parentTranscript + quotedNotification(LIVE_AGENT, 'completed'),
        42_000
      )
      const snapshots = await makeProvider().scan()
      expect(snapshots[0]!.dwarfs.map((dwarf) => dwarf.id)).toEqual([
        `claude:${SESSION_ID}`,
        `claude:${SESSION_ID}:${LIVE_AGENT}`
      ])
    })
  })

  /**
   * Regression (issue #28): the mirror image of the "finished agents" memory
   * above. A single long turn can write more than the 256KiB tail bound of
   * tool output, pushing the `async_launched` record out of the window while
   * the real agent is still working — deriving in-flight agents from the tail
   * alone made the worker dwarf silently leave mid-run: a false departure.
   */
  describe('launch memory', () => {
    const TRANSCRIPT = `${ROOT1}\\projects\\${ENCODED}\\${SESSION_ID}.jsonl`
    const MAIN_ID = `claude:${SESSION_ID}`
    const WORKER_ID = `claude:${SESSION_ID}:${LIVE_AGENT}`

    /**
     * What a bounded tail read returns mid-turn once heavy tool output pushed
     * every agent record out of the window: the opening prompt and a text
     * reply, no launches, no notifications, no turn_duration. This is exactly
     * the shape issue #28 was observed with — the agent is still running.
     */
    const quietTail = parentLines.slice(0, 2).join('\n') + '\n'

    /** A `system`/`turn_duration` line as Claude writes it at end of turn. */
    function turnDuration(pendingBackgroundAgentCount: number): string {
      return (
        JSON.stringify({
          type: 'system',
          subtype: 'turn_duration',
          durationMs: 1_000,
          messageCount: 1,
          pendingBackgroundAgentCount
        }) + '\n'
      )
    }

    /** ~1KiB that parses as no JSONL record at all — bulk without meaning. */
    const fillerLine = '#'.repeat(1024) + '\n'
    /** Enough filler to push everything before it past the 256KiB tail bound. */
    const pastRegularTail = fillerLine.repeat(300)

    it('keeps a worker whose launch record scrolled out of the transcript tail', async () => {
      const provider = makeProvider()
      // Poll one still sees the launch in the window.
      expect((await provider.scan())[0]!.dwarfs.map((dwarf) => dwarf.id)).toEqual([
        MAIN_ID,
        WORKER_ID
      ])

      // Poll two: the turn kept writing and the launch record scrolled out.
      // The agent is still working, so its dwarf must not leave the scene.
      fake.addFile(TRANSCRIPT, quietTail, 43_000)
      const second = await provider.scan()
      expect(second[0]!.dwarfs.map((dwarf) => dwarf.id)).toEqual([MAIN_ID, WORKER_ID])

      // The remembered worker is a full citizen, not a placeholder: launch-time
      // identity, its own subagent tail, and a routable delivery target.
      const worker = second[0]!.dwarfs[1]!
      expect(worker).toMatchObject({
        role: 'worker',
        name: 'Placeholder agent task',
        model: 'claude-fable-5',
        status: 'working',
        lastMessage: 'Subagent latest reply placeholder.'
      })
      expect(provider.textDelivery(WORKER_ID)).toEqual({
        kind: 'foreman-relay',
        foremanDwarfId: MAIN_ID,
        workerName: 'Placeholder agent task'
      })
    })

    it('drops a remembered worker on its terminal notification and never resurrects it', async () => {
      const provider = makeProvider()
      await provider.scan()

      // The launch scrolled out (remembered), then the agent finished.
      fake.addFile(TRANSCRIPT, quietTail + notification(LIVE_AGENT, 'completed'), 43_000)
      const second = await provider.scan()
      expect(second[0]!.dwarfs.map((dwarf) => dwarf.id)).toEqual([MAIN_ID])

      // Later the notification scrolls out too. If launch memory outranked
      // terminal memory here, the finished agent would come back — the exact
      // ghost this provider's terminal memory exists to prevent.
      fake.addFile(TRANSCRIPT, quietTail, 44_000)
      const third = await provider.scan()
      expect(third[0]!.dwarfs.map((dwarf) => dwarf.id)).toEqual([MAIN_ID])
    })

    it("forgets a session's launches when its registry entry disappears", async () => {
      const provider = makeProvider()
      await provider.scan()

      // The session ends: its registry file is gone, and with it the reason
      // to keep any launch memory alive.
      fake.removeFile(`${ROOT1}\\sessions\\32896.json`)
      expect(await provider.scan()).toEqual([])

      // A new registry entry for the same session id must start from what the
      // transcript says, not from stale memory: the quiet tail carries no
      // launch, so no worker may reappear.
      fake.addFile(`${ROOT1}\\sessions\\32896.json`, sessionEntry, 2_000)
      fake.addFile(TRANSCRIPT, quietTail, 45_000)
      const third = await provider.scan()
      expect(third[0]!.dwarfs.map((dwarf) => dwarf.id)).toEqual([MAIN_ID])
    })

    it("forgets a session's launches when its pid dies", async () => {
      const provider = makeProvider()
      await provider.scan()

      alivePids.clear()
      expect(await provider.scan()).toEqual([])

      alivePids.add(32896)
      fake.addFile(TRANSCRIPT, quietTail, 45_000)
      const third = await provider.scan()
      expect(third[0]!.dwarfs.map((dwarf) => dwarf.id)).toEqual([MAIN_ID])
    })

    it('drops a remembered worker when a turn ends with zero pending background agents', async () => {
      const provider = makeProvider()
      await provider.scan()

      // Both the launch AND its terminal notification scrolled past the tail
      // between polls (a sleep/wake gap, or one extreme write burst). The
      // transcript's own bookkeeping is the tie-breaker: a turn ended with
      // zero background agents pending, so every launch older than this whole
      // tail must have finished — without this cross-check the remembered
      // worker would mine forever.
      fake.addFile(TRANSCRIPT, quietTail + turnDuration(0), 43_000)
      const second = await provider.scan()
      expect(second[0]!.dwarfs.map((dwarf) => dwarf.id)).toEqual([MAIN_ID])
    })

    it('keeps a worker whose launch is still in the tail even when the pending count is zero', async () => {
      // The launch record sits INSIDE the tail, after the turn_duration line's
      // turn ended: the count predates the launch, so it proves nothing about
      // it. Evicting here would re-open the false-departure bug this memory
      // exists to fix — contradictory evidence must resolve toward keeping.
      fake.addFile(TRANSCRIPT, turnDuration(0) + parentLines.slice(6, 9).join('\n') + '\n', 42_000)
      const snapshots = await makeProvider().scan()
      expect(snapshots[0]!.dwarfs.map((dwarf) => dwarf.id)).toEqual([MAIN_ID, WORKER_ID])
    })

    it('recovers a launch beyond the regular tail on first sight of a session', async () => {
      // App restart while a long turn is mid-flight: the launch record is
      // already outside the regular window, so poll-to-poll memory alone can
      // never have seen it. First sight of a session reads one deeper tail to
      // recover exactly this — and the finished agent whose notification sits
      // in the same deep window must stay gone.
      fake.addFile(TRANSCRIPT, parentTranscript + pastRegularTail, 42_000)
      const provider = makeProvider()
      const first = await provider.scan()
      expect(first[0]!.dwarfs.map((dwarf) => dwarf.id)).toEqual([MAIN_ID, WORKER_ID])

      // What the deep read found lives on as ordinary launch memory: later
      // polls go back to the cheap bound without losing the worker.
      const second = await provider.scan()
      expect(second[0]!.dwarfs.map((dwarf) => dwarf.id)).toEqual([MAIN_ID, WORKER_ID])
    })

    it('leaves a launch beyond even the first-sight window invisible (known restart limit)', async () => {
      // The deep read is bounded too: a launch further back than its window
      // stays invisible until the agent's next observable event. Pinned so
      // the bound is a documented decision, not an accident.
      fake.addFile(TRANSCRIPT, parentTranscript + fillerLine.repeat(4_200), 42_000)
      const snapshots = await makeProvider().scan()
      expect(snapshots[0]!.dwarfs.map((dwarf) => dwarf.id)).toEqual([MAIN_ID])
    })

    /**
     * Regression (issue #36): the under-count direction of the very signal the
     * zero-pending eviction above already trusts. Measured live — a 4,093,313
     * byte transcript whose missing agent's launch sat at byte 3,668,176, some
     * 163KiB before the 256KiB window, while a `turn_duration` line well inside
     * that window reported 2 pending. The panel showed one worker; two were
     * really mining. Both cheap reads had already lost: poll-to-poll memory
     * never saw the record, and the session had outgrown the first-sight
     * window. The count is the only evidence left that a launch is missing.
     */
    describe('missing launch recovery', () => {
      const MISSING_AGENT = 'a9f1c2d3e4b5a6c70'
      const MISSING_WORKER_ID = `claude:${SESSION_ID}:${MISSING_AGENT}`

      /** The fixture's real launch record for the agent that stays visible. */
      const liveLaunch = parentLines[7]! + '\n'
      const missingLaunch = launch(MISSING_AGENT, 'Recovered agent task')

      /**
       * Two agents really in flight, but a burst of tool output pushed the
       * older launch past the regular window between polls: the routine tail
       * carries only the newer launch and a count of 2. This is the live shape.
       */
      const oneLaunchOutOfWindow = missingLaunch + pastRegularTail + liveLaunch + turnDuration(2)

      /**
       * The same reported shortfall with nothing to find at any depth — the
       * count names an agent whose launch is in no part of this transcript.
       */
      const nothingToRecover = pastRegularTail + liveLaunch + turnDuration(2)

      /**
       * Counts transcript reads that reached past the first-sight window.
       * Poll one of every test here is the session's first sight, so its bound
       * is the deepest routine read that exists — any larger read can only be
       * a recovery escalation. Derived from the calls themselves rather than
       * copying the provider's byte constants, so this stays a statement about
       * escalation instead of a duplicate of the tiers.
       */
      function watchRecoveryReads(): () => number {
        const reads = vi.spyOn(fake, 'readTextTail')
        return () => {
          const bounds = reads.mock.calls
            .filter(([path]) => path === TRANSCRIPT)
            .map(([, maxBytes]) => maxBytes)
          return bounds.filter((bound) => bound > (bounds[0] ?? 0)).length
        }
      }

      it('recovers a launch the tail never saw when the pending count reports one more', async () => {
        const provider = makeProvider()
        const recoveryReads = watchRecoveryReads()
        // Poll one: a quiet session with nothing out and no count to compare.
        fake.addFile(TRANSCRIPT, quietTail, 42_000)
        expect((await provider.scan())[0]!.dwarfs.map((dwarf) => dwarf.id)).toEqual([MAIN_ID])
        expect(recoveryReads()).toBe(0)

        // Poll two: the routine tail knows one agent, the transcript's own
        // bookkeeping says two are pending. The missing worker was mining the
        // whole time and must appear, recovered from the deeper window.
        fake.addFile(TRANSCRIPT, oneLaunchOutOfWindow, 43_000)
        const second = await provider.scan()
        expect(second[0]!.dwarfs.map((dwarf) => dwarf.id)).toEqual([
          MAIN_ID,
          WORKER_ID,
          MISSING_WORKER_ID
        ])
        expect(recoveryReads()).toBe(1)

        // Recovered as a full citizen with its launch-time identity, not as a
        // placeholder standing in for a headcount.
        expect(second[0]!.dwarfs[2]).toMatchObject({
          role: 'worker',
          name: 'Recovered agent task',
          model: 'claude-fable-5',
          status: 'working'
        })
        expect(provider.textDelivery(MISSING_WORKER_ID)).toEqual({
          kind: 'foreman-relay',
          foremanDwarfId: MAIN_ID,
          workerName: 'Recovered agent task'
        })

        // What the deep read found lives on as ordinary launch memory: the
        // next poll keeps the worker without escalating again.
        const third = await provider.scan()
        expect(third[0]!.dwarfs.map((dwarf) => dwarf.id)).toEqual([
          MAIN_ID,
          WORKER_ID,
          MISSING_WORKER_ID
        ])
        expect(recoveryReads()).toBe(1)
      })

      it('escalates once, not every poll, while the same shortfall persists', async () => {
        const provider = makeProvider()
        const recoveryReads = watchRecoveryReads()
        fake.addFile(TRANSCRIPT, quietTail, 42_000)
        await provider.scan()

        // A shortfall the deeper window cannot explain. The poller runs every
        // 2s against files that reach megabytes, so re-reading on each tick is
        // the unbounded scan this rate limit exists to prevent.
        fake.addFile(TRANSCRIPT, nothingToRecover, 43_000)
        await provider.scan()
        await provider.scan()
        await provider.scan()
        expect(recoveryReads()).toBe(1)
      })

      it('settles an unexplainable shortfall without inventing a dwarf', async () => {
        const provider = makeProvider()
        fake.addFile(TRANSCRIPT, quietTail, 42_000)
        await provider.scan()

        // The count may describe background work this provider has no launch
        // record for at any depth. A headcount is not an identity: the crew
        // stays exactly what the transcript can prove, poll after poll.
        fake.addFile(TRANSCRIPT, nothingToRecover, 43_000)
        for (const poll of [1, 2, 3]) {
          const snapshots = await provider.scan()
          expect(
            snapshots[0]!.dwarfs.map((dwarf) => dwarf.id),
            `poll ${poll}`
          ).toEqual([MAIN_ID, WORKER_ID])
        }
      })

      it('drops a recovered worker on its terminal notification and never resurrects it', async () => {
        const provider = makeProvider()
        fake.addFile(TRANSCRIPT, quietTail, 42_000)
        await provider.scan()
        fake.addFile(TRANSCRIPT, oneLaunchOutOfWindow, 43_000)
        expect((await provider.scan())[0]!.dwarfs.map((dwarf) => dwarf.id)).toEqual([
          MAIN_ID,
          WORKER_ID,
          MISSING_WORKER_ID
        ])

        // The recovered agent finishes. Its notification arrives in the
        // routine tail while the count line ahead of it still says 2 — a stale
        // count must never re-adopt an agent whose end has been seen, or the
        // deep read becomes a resurrection machine.
        fake.addFile(
          TRANSCRIPT,
          oneLaunchOutOfWindow + notification(MISSING_AGENT, 'completed'),
          44_000
        )
        const third = await provider.scan()
        expect(third[0]!.dwarfs.map((dwarf) => dwarf.id)).toEqual([MAIN_ID, WORKER_ID])

        const fourth = await provider.scan()
        expect(fourth[0]!.dwarfs.map((dwarf) => dwarf.id)).toEqual([MAIN_ID, WORKER_ID])
      })

      it('leaves the zero-pending eviction path untouched and never escalates for it', async () => {
        const provider = makeProvider()
        const recoveryReads = watchRecoveryReads()
        await provider.scan()

        // Zero pending can never be a shortfall, so the two readings of the
        // same count cannot collide: eviction still fires, and no deep read is
        // provoked on the way.
        fake.addFile(TRANSCRIPT, quietTail + turnDuration(0), 43_000)
        const second = await provider.scan()
        expect(second[0]!.dwarfs.map((dwarf) => dwarf.id)).toEqual([MAIN_ID])
        expect(recoveryReads()).toBe(0)
      })

      it('escalates again when the reported count climbs past the settled shortfall', async () => {
        const provider = makeProvider()
        const recoveryReads = watchRecoveryReads()
        fake.addFile(TRANSCRIPT, quietTail, 42_000)
        await provider.scan()

        // One unexplainable shortfall, attempted once and settled at 2.
        fake.addFile(TRANSCRIPT, nothingToRecover, 43_000)
        await provider.scan()
        await provider.scan()
        expect(recoveryReads()).toBe(1)

        // A THIRD agent is now reported. Keying the one-shot on a per-session
        // "already tried" flag would spend the session's single recovery on
        // the first discrepancy and go blind to every later one — this newer,
        // larger count is fresh evidence and must be chased.
        fake.addFile(
          TRANSCRIPT,
          missingLaunch + pastRegularTail + liveLaunch + turnDuration(3),
          44_000
        )
        const fourth = await provider.scan()
        expect(fourth[0]!.dwarfs.map((dwarf) => dwarf.id)).toEqual([
          MAIN_ID,
          WORKER_ID,
          MISSING_WORKER_ID
        ])
        expect(recoveryReads()).toBe(2)
      })

      it('escalates again for an identical count once the shortfall has cleared', async () => {
        const provider = makeProvider()
        const recoveryReads = watchRecoveryReads()
        fake.addFile(TRANSCRIPT, quietTail, 42_000)
        await provider.scan()

        // Shortfall of 2, unexplainable, settled after one attempt.
        fake.addFile(TRANSCRIPT, nothingToRecover, 43_000)
        await provider.scan()
        expect(recoveryReads()).toBe(1)

        // The count comes back down: nothing is missing any more, so the
        // settled shortfall is over and must be forgotten.
        fake.addFile(TRANSCRIPT, quietTail + turnDuration(1), 44_000)
        await provider.scan()

        // A LATER discrepancy that happens to report the same number is a new
        // shortfall, not the old one still pending. Remembering the count
        // forever would make this recoverable worker permanently invisible.
        fake.addFile(TRANSCRIPT, oneLaunchOutOfWindow, 45_000)
        const fifth = await provider.scan()
        expect(fifth[0]!.dwarfs.map((dwarf) => dwarf.id)).toEqual([
          MAIN_ID,
          WORKER_ID,
          MISSING_WORKER_ID
        ])
        expect(recoveryReads()).toBe(2)
      })
    })

    /**
     * Regression (issue #40): the exit neither #28 nor #36 has. An agent that
     * dies WITH its parent's turn — the session was interrupted mid-turn —
     * never writes a terminal `<task-notification>`, so its launch stays
     * remembered forever and its dwarf mines for an agent that stopped hours
     * ago. Observed live: a background session idle since 22:33 the previous
     * evening whose transcript ends at `"pendingBackgroundAgentCount":1`.
     *
     * The rule has to separate "I cannot see the launch record" — keep the
     * worker, which is the whole point of #28 — from "the parent proves nothing
     * is running". Only an IDLE session (neither `busy` nor `waiting`: both are
     * mid-turn) that has produced nothing for a whole window, in its own
     * transcript AND in the worker's, is that proof.
     *
     * The two silences are weighed differently, because they are not equally
     * telling: a foreman legitimately sits idle waiting for a human to type, so
     * its silence is weak evidence, while a launched subagent runs to
     * completion and cannot wait on anyone — so its silence is strong. Each
     * transcript is therefore measured against its own window, and both must
     * elapse. These tests drive scaled stand-ins for the product's hour and
     * half-hour, keeping the same 2:1 shape.
     */
    describe('stale launch memory (issue #40)', () => {
      const SUBAGENT = `${ROOT1}\\projects\\${ENCODED}\\${SESSION_ID}\\subagents\\agent-${LIVE_AGENT}.jsonl`
      const MINUTE = 60_000
      const HOUR = 60 * MINUTE
      /** Stand-in for the product's hour of foreman silence. */
      const FOREMAN_WINDOW = 60_000
      /** Stand-in for the product's half hour of worker silence. */
      const WORKER_WINDOW = 30_000
      /** When both transcripts were last written, before each test moves on. */
      const LAST_WRITE = 42_000

      let clock = LAST_WRITE

      /**
       * The provider with the clock this describe drives and windows small
       * enough to cross inside a test. Both omitted entirely — see the default
       * tests at the end — is what exercises the product's own windows.
       */
      function staleAwareProvider(
        foremanSilenceMs = FOREMAN_WINDOW,
        workerSilenceMs = WORKER_WINDOW
      ): ClaudeProvider {
        return new ClaudeProvider({
          fs: fake,
          roots: [ROOT1],
          isPidAlive: (pid) => alivePids.has(pid),
          now: () => clock,
          foremanSilenceMs,
          workerSilenceMs
        })
      }

      /** The provider with the product's own windows; only the clock is fake. */
      function providerWithProductWindows(): ClaudeProvider {
        return new ClaudeProvider({
          fs: fake,
          roots: [ROOT1],
          isPidAlive: (pid) => alivePids.has(pid),
          now: () => clock
        })
      }

      /** The fixture registry entry with its status replaced. */
      function entryWithStatus(status: string): string {
        return JSON.stringify({ ...JSON.parse(sessionEntry), status })
      }

      /** Nothing in this session written since `mtimeMs` — parent or worker. */
      function freezeTranscripts(mtimeMs: number): void {
        fake.addFile(TRANSCRIPT, parentTranscript, mtimeMs)
        fake.addFile(SUBAGENT, subagentTranscript, mtimeMs)
      }

      /**
       * Age each transcript independently as of the current `clock`, which is
       * what lets one window be crossed while the other is not. Call it after
       * setting `clock`.
       */
      function silentFor(ages: { foremanMs: number; workerMs: number }): void {
        fake.addFile(TRANSCRIPT, parentTranscript, clock - ages.foremanMs)
        fake.addFile(SUBAGENT, subagentTranscript, clock - ages.workerMs)
      }

      beforeEach(() => {
        clock = LAST_WRITE
        fake.addFile(`${ROOT1}\\sessions\\32896.json`, entryWithStatus('idle'), 1_000)
        freezeTranscripts(LAST_WRITE)
      })

      it('drops a remembered worker once its idle parent has been silent for the window', async () => {
        const provider = staleAwareProvider()
        // While the evidence is fresh the worker is a full citizen: an idle
        // parent with agents out renders a resting foreman beside it.
        expect((await provider.scan())[0]!.dwarfs.map((d) => d.id)).toEqual([MAIN_ID, WORKER_ID])

        // The session was kicked mid-turn, so no terminal notification will
        // ever arrive and neither transcript is written again. Both transcripts
        // froze together, so the longer of the two windows is the binding one:
        // once it passes, the parent has proved nothing is running.
        clock = LAST_WRITE + FOREMAN_WINDOW
        const second = await provider.scan()
        expect(second[0]!.status).toBe('idle')
        expect(second[0]!.dwarfs).toEqual([])
      })

      it('keeps the worker one millisecond before both windows have elapsed', async () => {
        clock = LAST_WRITE + FOREMAN_WINDOW - 1
        const snapshots = await staleAwareProvider().scan()
        expect(snapshots[0]!.dwarfs.map((d) => d.id)).toEqual([MAIN_ID, WORKER_ID])
      })

      it('drops the worker the moment both windows have exactly elapsed', async () => {
        clock = LAST_WRITE + FOREMAN_WINDOW
        const snapshots = await staleAwareProvider().scan()
        expect(snapshots[0]!.dwarfs).toEqual([])
      })

      it('keeps a worker still inside its own window though its foreman passed one', async () => {
        // The foreman has said nothing for its whole hour — on its own that is
        // the weak half of the evidence, because an orchestrator waiting for a
        // human to type looks exactly like this. The worker wrote one
        // millisecond inside its own window, so it is still producing.
        clock = LAST_WRITE + FOREMAN_WINDOW * 2
        silentFor({ foremanMs: FOREMAN_WINDOW, workerMs: WORKER_WINDOW - 1 })
        const snapshots = await staleAwareProvider().scan()
        expect(snapshots[0]!.dwarfs.map((d) => d.id)).toEqual([MAIN_ID, WORKER_ID])
      })

      it('keeps a worker past its own window while its foreman is still inside one', async () => {
        // The mirror case: the worker has been silent past its half hour, but
        // the foreman wrote a moment ago, so a turn produced something in this
        // session recently and the launch memory holds.
        clock = LAST_WRITE + FOREMAN_WINDOW * 2
        silentFor({ foremanMs: FOREMAN_WINDOW - 1, workerMs: WORKER_WINDOW })
        const snapshots = await staleAwareProvider().scan()
        expect(snapshots[0]!.dwarfs.map((d) => d.id)).toEqual([MAIN_ID, WORKER_ID])
      })

      it('drops the worker only once each transcript has passed its own window', async () => {
        // Both silences are past their own thresholds at the same poll — the
        // only shape the ANDed rule accepts. Note the worker crossed its window
        // long before this: the foreman's longer one is what held it here.
        clock = LAST_WRITE + FOREMAN_WINDOW * 2
        silentFor({ foremanMs: FOREMAN_WINDOW, workerMs: WORKER_WINDOW })
        const snapshots = await staleAwareProvider().scan()
        expect(snapshots[0]!.dwarfs).toEqual([])
      })

      it('keeps a worker whose busy parent has written nothing this rule can see', async () => {
        // THE regression guard for #28. A long turn writing megabytes of tool
        // output pushes the launch record out of the window, so the routine
        // tail shows no launch at all — the exact false-departure shape. The
        // parent is BUSY: no amount of elapsed time turns "I cannot see the
        // launch record" into "nothing is running".
        fake.addFile(`${ROOT1}\\sessions\\32896.json`, entryWithStatus('busy'), 1_000)
        const provider = staleAwareProvider()
        expect((await provider.scan())[0]!.dwarfs.map((d) => d.id)).toEqual([MAIN_ID, WORKER_ID])

        fake.addFile(TRANSCRIPT, quietTail, LAST_WRITE)
        clock = LAST_WRITE + FOREMAN_WINDOW * 100
        const second = await provider.scan()
        expect(second[0]!.dwarfs.map((d) => d.id)).toEqual([MAIN_ID, WORKER_ID])
      })

      it('keeps a worker while its parent waits, which is still mid-turn', async () => {
        // #34's `waiting` means alive but blocked — on user input, a dialog, or
        // a LONG TOOL. A turn is still in flight there, so a subagent launched
        // inside it can be computing: only `idle` proves no turn is running.
        fake.addFile(`${ROOT1}\\sessions\\32896.json`, entryWithStatus('waiting'), 1_000)
        const provider = staleAwareProvider()
        await provider.scan()

        clock = LAST_WRITE + FOREMAN_WINDOW * 100
        const second = await provider.scan()
        expect(second[0]!.dwarfs.map((d) => d.id)).toEqual([MAIN_ID, WORKER_ID])
      })

      it('keeps a worker that is still writing its own transcript under an idle parent', async () => {
        // A turn CAN end with background agents pending — that is precisely
        // what pendingBackgroundAgentCount records — so an idle parent is not
        // proof by itself. While the worker's own transcript keeps growing it
        // is producing, and dropping it would be the false departure again.
        const provider = staleAwareProvider()
        await provider.scan()

        // The parent has been quiet for three foreman windows; the worker wrote
        // a moment ago.
        clock = LAST_WRITE + FOREMAN_WINDOW * 3
        fake.addFile(SUBAGENT, subagentTranscript, clock - 1)
        expect((await provider.scan())[0]!.dwarfs.map((d) => d.id)).toEqual([MAIN_ID, WORKER_ID])

        // ...and is still writing when the session picks up a turn again.
        clock += FOREMAN_WINDOW * 3
        fake.addFile(SUBAGENT, subagentTranscript, clock)
        fake.addFile(`${ROOT1}\\sessions\\32896.json`, entryWithStatus('busy'), 2_000)
        expect((await provider.scan())[0]!.dwarfs.map((d) => d.id)).toEqual([MAIN_ID, WORKER_ID])
      })

      it('still drops a worker on its terminal notification without waiting for the window', async () => {
        const provider = staleAwareProvider()
        await provider.scan()

        // Proof outranks silence: the notification lands while every transcript
        // is fresh, and the worker leaves on that poll, not one window later.
        fake.addFile(TRANSCRIPT, parentTranscript + notification(LIVE_AGENT, 'completed'), clock)
        const second = await provider.scan()
        expect(second[0]!.dwarfs).toEqual([])
      })

      it('never brings a stale worker back when its session goes busy again', async () => {
        const provider = staleAwareProvider()
        await provider.scan()
        clock = LAST_WRITE + FOREMAN_WINDOW
        expect((await provider.scan())[0]!.dwarfs).toEqual([])

        // Next morning the user types a new prompt. The dead agent's launch
        // record is STILL in the tail — nothing has scrolled it out — so a rule
        // that only re-derived staleness each poll would re-adopt it and the
        // ghost would be back the moment the session resumed.
        fake.addFile(`${ROOT1}\\sessions\\32896.json`, entryWithStatus('busy'), 2_000)
        clock += FOREMAN_WINDOW
        fake.addFile(TRANSCRIPT, parentTranscript, clock)
        const third = await provider.scan()
        expect(third[0]!.dwarfs.map((d) => d.id)).toEqual([MAIN_ID])
      })

      it('never lets the under-count recovery re-adopt a stale worker', async () => {
        // #36 escalates one deep read whenever the pending count exceeds what
        // the provider knows, and that read reaches back far enough to find the
        // dead agent's launch record. Staleness has to outrank it exactly the
        // way terminal memory does, or the deep read becomes a resurrection
        // machine for the very ghost this rule buries.
        const GHOST = 'aa11bb22cc33dd440'
        const reads = vi.spyOn(fake, 'readTextTail')
        const deepReads = (): number => {
          const bounds = reads.mock.calls
            .filter(([path]) => path === TRANSCRIPT)
            .map(([, maxBytes]) => maxBytes)
          return bounds.filter((bound) => bound > (bounds[0] ?? 0)).length
        }
        fake.addFile(TRANSCRIPT, launch(GHOST, 'Ghost agent') + turnDuration(1), LAST_WRITE)
        const provider = staleAwareProvider()
        expect((await provider.scan())[0]!.dwarfs.map((d) => d.id)).toEqual([
          MAIN_ID,
          `claude:${SESSION_ID}:${GHOST}`
        ])

        clock = LAST_WRITE + FOREMAN_WINDOW
        expect((await provider.scan())[0]!.dwarfs).toEqual([])

        // The launch record scrolls out of the routine tail while the count
        // line stays inside it: a textbook #36 shortfall, chased exactly once.
        fake.addFile(
          TRANSCRIPT,
          launch(GHOST, 'Ghost agent') + pastRegularTail + turnDuration(1),
          clock
        )
        const third = await provider.scan()
        expect(deepReads()).toBe(1)
        expect(third[0]!.dwarfs).toEqual([])
      })

      it('uses generous default windows when none are injected', async () => {
        // Ten minutes of silence is not proof: a subagent grinding through one
        // long tool call writes nothing at all until that call returns. Both
        // defaults have to be long enough that only a truly dead agent trips
        // them, so these last tests inject no window at all.
        clock = LAST_WRITE + 10 * MINUTE
        const snapshots = await providerWithProductWindows().scan()
        expect(snapshots[0]!.dwarfs.map((d) => d.id)).toEqual([MAIN_ID, WORKER_ID])
      })

      /**
       * The next three pin the product's own two windows against each other,
       * from both sides, so the asymmetry cannot be quietly "simplified" back
       * into a single number: collapsing them to one value fails at least one
       * of these, whichever value is chosen.
       */
      it('keeps a worker whose foreman has been silent 59 minutes', async () => {
        // Inside the foreman's hour, though well past the worker's half hour.
        clock = LAST_WRITE + 4 * HOUR
        silentFor({ foremanMs: 59 * MINUTE, workerMs: 31 * MINUTE })
        const snapshots = await providerWithProductWindows().scan()
        expect(snapshots[0]!.dwarfs.map((d) => d.id)).toEqual([MAIN_ID, WORKER_ID])
      })

      it('keeps a worker that wrote 29 minutes ago even past the foreman hour', async () => {
        // The mirror: the foreman's hour has passed, the worker's half hour
        // has not, and a launched subagent that recently produced output is the
        // strong evidence here — it cannot be waiting on a human.
        clock = LAST_WRITE + 4 * HOUR
        silentFor({ foremanMs: 61 * MINUTE, workerMs: 29 * MINUTE })
        const snapshots = await providerWithProductWindows().scan()
        expect(snapshots[0]!.dwarfs.map((d) => d.id)).toEqual([MAIN_ID, WORKER_ID])
      })

      it('drops the worker once an hour of foreman and half of one of worker have passed', async () => {
        clock = LAST_WRITE + 4 * HOUR
        silentFor({ foremanMs: 61 * MINUTE, workerMs: 31 * MINUTE })
        const snapshots = await providerWithProductWindows().scan()
        expect(snapshots[0]!.dwarfs).toEqual([])
      })
    })

    /**
     * Regression (issue #45): the fourth quadrant of the same number. #28 reads
     * the count at exactly zero, #36 reads it too HIGH, #40 answers the case no
     * count can — and nobody read it too LOW. Measured live: a panel showing 8
     * workers for a session whose own `turn_duration` line reported 3 pending,
     * on a 15.7MB transcript whose 256KiB tail carried 0 launch records and 1
     * notification. Five dwarfs were swinging pickaxes at nothing.
     *
     * `pendingBackgroundAgentCount` is Claude Code stating how many background
     * agents it has, so it is a CEILING and it binds on the poll that reads it:
     * a headcount known to be false must never survive a tick while the
     * provider goes looking for corroboration. #40 cannot reach this case at
     * all — it requires an `idle` parent, and ghosts accumulate precisely while
     * a session is busy, which is exactly when the panel is being watched.
     */
    describe('pending count as a ceiling (issue #45)', () => {
      /** Eight background agents in launch order — the reported panel's crew. */
      const GHOSTS = Array.from({ length: 8 }, (_, index) => `a${index + 1}0000000000000f`)
      /** An agent launched later than any of them, for the under-count tests. */
      const FRESH_AGENT = 'b7c1d2e3f4a5b6c70'

      function ghostLaunch(index: number): string {
        return launch(GHOSTS[index]!, `Ghost task ${index + 1}`)
      }

      /** Every launch record in order, small enough to sit inside any window. */
      const eightLaunches = GHOSTS.map((_, index) => ghostLaunch(index)).join('')

      /** The panel's dwarf ids for a crew of `agentIds`, foreman first. */
      function crew(...agentIds: string[]): string[] {
        return [MAIN_ID, ...agentIds.map((agentId) => `claude:${SESSION_ID}:${agentId}`)]
      }

      /**
       * Counts transcript reads deeper than this session's first-sight bound.
       * Poll one of every test here is the session's first sight, so its bound
       * is the deepest routine read that exists and anything larger can only be
       * an escalation. Derived from the calls themselves rather than by copying
       * the provider's byte constants, so it stays a statement about
       * escalation instead of a duplicate of the tiers.
       */
      function watchDeepReads(): () => number {
        const reads = vi.spyOn(fake, 'readTextTail')
        return () => {
          const bounds = reads.mock.calls
            .filter(([path]) => path === TRANSCRIPT)
            .map(([, maxBytes]) => maxBytes)
          return bounds.filter((bound) => bound > (bounds[0] ?? 0)).length
        }
      }

      /** Poll one: every launch record is in the window, so all eight are believed. */
      async function rememberEightGhosts(provider: ClaudeProvider): Promise<void> {
        fake.addFile(TRANSCRIPT, eightLaunches, 42_000)
        const first = await provider.scan()
        expect(first[0]!.dwarfs.map((d) => d.id)).toEqual(crew(...GHOSTS))
      }

      /** Poll two: the count binds, and the five oldest beliefs go. */
      async function pruneToThree(provider: ClaudeProvider): Promise<void> {
        await rememberEightGhosts(provider)
        fake.addFile(TRANSCRIPT, quietTail + turnDuration(3), 43_000)
        const second = await provider.scan()
        expect(second[0]!.dwarfs.map((d) => d.id)).toEqual(crew(...GHOSTS.slice(5)))
      }

      it('prunes eight remembered agents down to a reported count of three', async () => {
        const provider = makeProvider()
        const deepReads = watchDeepReads()
        await rememberEightGhosts(provider)

        // The measured shape: a busy session whose window no longer carries a
        // single launch record, and whose own bookkeeping says three. The
        // ceiling binds on THIS poll — there is no deeper read to be had here,
        // the whole transcript already sat inside the window this poll read,
        // and a number known to be false must not outlive the tick that saw it.
        fake.addFile(TRANSCRIPT, quietTail + turnDuration(3), 43_000)
        const second = await provider.scan()
        expect(second[0]!.dwarfs.map((d) => d.id)).toEqual(crew(...GHOSTS.slice(5)))
        expect(deepReads()).toBe(0)

        // The SAME three next poll. The order is a property of the remembered
        // crew rather than a fresh guess each tick, so dwarfs cannot flicker.
        fake.addFile(TRANSCRIPT, quietTail + turnDuration(3), 44_000)
        const third = await provider.scan()
        expect(third[0]!.dwarfs.map((d) => d.id)).toEqual(crew(...GHOSTS.slice(5)))
      })

      it('changes nothing when the count matches what is already known', async () => {
        const provider = makeProvider()
        const deepReads = watchDeepReads()
        await rememberEightGhosts(provider)

        // Agreement is not a discrepancy: nothing is pruned, and no read is
        // escalated even though this transcript is long enough to afford one.
        fake.addFile(TRANSCRIPT, pastRegularTail + turnDuration(8), 43_000)
        const second = await provider.scan()
        expect(second[0]!.dwarfs.map((d) => d.id)).toEqual(crew(...GHOSTS))
        expect(deepReads()).toBe(0)
      })

      it('never prunes a launch still visible in the tail, however low the count', async () => {
        const provider = makeProvider()
        await rememberEightGhosts(provider)

        // A `turn_duration` line is written at the END of a turn, so agents
        // launched after it are not in its number. #28 exempts in-tail launches
        // from the zero reading for exactly this reason, and a ceiling that
        // ignored the same boundary would kill the agents a busy turn had just
        // started — the false departure this launch memory exists to prevent.
        fake.addFile(TRANSCRIPT, turnDuration(1) + eightLaunches, 43_000)
        const second = await provider.scan()
        expect(second[0]!.dwarfs.map((d) => d.id)).toEqual(crew(...GHOSTS))
      })

      it('drops the agents a deep read proves finished rather than the oldest ones', async () => {
        const provider = makeProvider()
        const deepReads = watchDeepReads()
        await rememberEightGhosts(provider)

        // Five terminal notifications sit past the routine window but inside
        // the recovery one. Oldest-belief-first would have kept the last three
        // launched; the record says the survivors are the second, fourth and
        // sixth. The count decides HOW MANY on every poll, the deep read
        // decides WHICH whenever one can be afforded.
        const finished = [0, 2, 4, 6, 7]
        fake.addFile(
          TRANSCRIPT,
          eightLaunches +
            finished.map((index) => notification(GHOSTS[index]!, 'completed')).join('') +
            pastRegularTail +
            turnDuration(3),
          43_000
        )
        const second = await provider.scan()
        expect(second[0]!.dwarfs.map((d) => d.id)).toEqual(crew(GHOSTS[1]!, GHOSTS[3]!, GHOSTS[5]!))
        expect(deepReads()).toBe(1)
      })

      it('never re-adopts a pruned agent when its launch record returns to the tail', async () => {
        const provider = makeProvider()
        await pruneToThree(provider)

        // A quieter turn leaves every launch record inside the window again,
        // and the count now agrees with the crew this provider WOULD rebuild.
        // Without a sticky record of the pruning the tail merge alone would
        // refill the panel and it would oscillate 3, 8, 3, 8 for the session's
        // whole life — the same reason #40 remembers what it abandoned.
        fake.addFile(TRANSCRIPT, eightLaunches + turnDuration(8), 44_000)
        const third = await provider.scan()
        expect(third[0]!.dwarfs.map((d) => d.id)).toEqual(crew(...GHOSTS.slice(5)))
      })

      it('still escalates for an under-count after a ceiling prune', async () => {
        const provider = makeProvider()
        const deepReads = watchDeepReads()
        await pruneToThree(provider)

        // A genuinely new agent launches and its record scrolls past the
        // routine window before any poll sees it, while the count climbs to
        // four. Both readings of the same number stay live: the ceiling shed
        // five beliefs a moment ago, and this shortfall must still be chased.
        fake.addFile(
          TRANSCRIPT,
          eightLaunches +
            launch(FRESH_AGENT, 'Fresh agent task') +
            pastRegularTail +
            turnDuration(4),
          44_000
        )
        const third = await provider.scan()
        expect(third[0]!.dwarfs.map((d) => d.id)).toEqual(crew(...GHOSTS.slice(5), FRESH_AGENT))
        expect(deepReads()).toBe(1)
      })

      it('never re-adopts a pruned agent through a later under-count deep read', async () => {
        const provider = makeProvider()
        await pruneToThree(provider)

        // The recovery window reaches every one of the eight launch records,
        // and the count asks for six. Ended memory outranks launch memory, so
        // an unexplainable shortfall settles without inventing a dwarf instead
        // of refilling the panel with the ghosts the ceiling just cleared.
        fake.addFile(TRANSCRIPT, eightLaunches + pastRegularTail + turnDuration(6), 44_000)
        for (const poll of [1, 2, 3]) {
          const snapshots = await provider.scan()
          expect(
            snapshots[0]!.dwarfs.map((d) => d.id),
            `poll ${poll}`
          ).toEqual(crew(...GHOSTS.slice(5)))
        }
      })

      it('escalates once, not every poll, while a surplus keeps returning at the same count', async () => {
        const provider = makeProvider()
        const deepReads = watchDeepReads()
        await rememberEightGhosts(provider)

        // Poll two: six launch records have scrolled out, two are still in the
        // window, and the count is three. Only the six the count can speak for
        // are candidates, so three of those go — and one deep read is spent
        // looking for the notifications that would name them exactly.
        fake.addFile(
          TRANSCRIPT,
          [0, 1, 2, 3, 4, 5].map(ghostLaunch).join('') +
            pastRegularTail +
            ghostLaunch(6) +
            ghostLaunch(7) +
            turnDuration(3),
          43_000
        )
        const second = await provider.scan()
        expect(second[0]!.dwarfs.map((d) => d.id)).toEqual(crew(...GHOSTS.slice(3)))
        expect(deepReads()).toBe(1)

        // Poll three: the last two records scroll out too, so the same count
        // now has five beliefs to judge and a fresh surplus appears. The poller
        // ticks every 2s against files that reach megabytes — the ceiling must
        // still land, and the 16MiB read must not.
        fake.addFile(TRANSCRIPT, pastRegularTail + turnDuration(3), 44_000)
        const third = await provider.scan()
        expect(third[0]!.dwarfs.map((d) => d.id)).toEqual(crew(...GHOSTS.slice(5)))
        expect(deepReads()).toBe(1)

        // Poll four: reconciled. Nothing left to prune, nothing to read.
        fake.addFile(TRANSCRIPT, pastRegularTail + turnDuration(3), 45_000)
        const fourth = await provider.scan()
        expect(fourth[0]!.dwarfs.map((d) => d.id)).toEqual(crew(...GHOSTS.slice(5)))
        expect(deepReads()).toBe(1)
      })

      it('leaves a zero count to the eviction that owns it, without escalating a read', async () => {
        const provider = makeProvider()
        const deepReads = watchDeepReads()
        await rememberEightGhosts(provider)

        // Zero is #28's reading of this same number, and it already empties the
        // crew of every launch older than the tail. The ceiling must find
        // nothing left to judge — and must certainly not spend a 16MiB read
        // confirming an eviction that has already happened.
        fake.addFile(TRANSCRIPT, pastRegularTail + turnDuration(0), 43_000)
        const second = await provider.scan()
        expect(second[0]!.dwarfs.map((d) => d.id)).toEqual([MAIN_ID])
        expect(deepReads()).toBe(0)
      })
    })
  })

  it('maps an idle session to a snapshot with no dwarfs', async () => {
    fake.addFile(
      `${ROOT2}\\sessions\\40000.json`,
      otherEntry(
        40000,
        'bbbbbbbb-0000-0000-0000-000000000000',
        'C:\\Users\\j\\Desktop\\Other',
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
        'C:\\Users\\j\\Desktop\\Other',
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

  describe('secret redaction at the provider boundary', () => {
    // Fixture-shaped fake, never a real credential.
    const FAKE_PAT = 'ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE1234'

    function assistantLine(text: string): string {
      return (
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            model: 'claude-fable-5',
            content: [{ type: 'text', text }]
          }
        }) + '\n'
      )
    }

    function userLine(text: string): string {
      return JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n'
    }

    it('redacts a pasted token out of the foreman lastMessage', async () => {
      fake.addFile(
        `${ROOT1}\\projects\\${ENCODED}\\${SESSION_ID}.jsonl`,
        parentTranscript + assistantLine(`Configured auth with ${FAKE_PAT} as requested.`),
        42_000
      )
      const snapshots = await makeProvider().scan()
      // Redaction happens before the renderer's truncation ever sees the text,
      // so no truncated prefix can still carry a whole key.
      expect(snapshots[0]!.dwarfs[0]!.lastMessage).toBe(
        'Configured auth with [redacted] as requested.'
      )
    })

    it('redacts a worker lastMessage read from its subagent transcript', async () => {
      fake.addFile(
        `${ROOT1}\\projects\\${ENCODED}\\${SESSION_ID}\\subagents\\agent-a34eaebecc3d57381.jsonl`,
        subagentTranscript + assistantLine(`Found key ${FAKE_PAT} in the env file.`),
        43_000
      )
      const snapshots = await makeProvider().scan()
      const worker = snapshots[0]!.dwarfs[1]!
      expect(worker.lastMessage).toBe('Found key [redacted] in the env file.')
    })

    it('redacts user and assistant feed messages alike', async () => {
      // The feed modal shows what the USER typed too — pasting a key into a
      // session is exactly the most common way a secret enters a transcript.
      fake.addFile(
        `${ROOT1}\\projects\\${ENCODED}\\${SESSION_ID}.jsonl`,
        parentTranscript +
          userLine(`use ${FAKE_PAT} for the deploy`) +
          assistantLine(`Done, ${FAKE_PAT} is configured.`),
        42_000
      )
      const provider = makeProvider()
      await provider.scan()
      const feed = await provider.feed(`claude:${SESSION_ID}`, 20)
      expect(feed!.map((m) => m.text)).toContain('use [redacted] for the deploy')
      expect(feed!.map((m) => m.text)).toContain('Done, [redacted] is configured.')
      expect(JSON.stringify(feed)).not.toContain(FAKE_PAT)
    })

    /**
     * The fixture transcript with the live agent's launch line swapped for
     * `record`, so a description can be chosen without disturbing the session
     * entry, the agent id, or the subagent tail the rest of the suite relies on.
     */
    function withLaunchRecord(record: string): string {
      return (
        parentLines.slice(0, 7).join('\n') + '\n' + record + parentLines.slice(8).join('\n') + '\n'
      )
    }

    it('redacts a subagent task description before it becomes a name and a tooltip', async () => {
      // Free text the orchestrating session typed, reaching the panel twice —
      // as the worker's name and as its tooltip line (issue #59).
      fake.addFile(
        `${ROOT1}\\projects\\${ENCODED}\\${SESSION_ID}.jsonl`,
        withLaunchRecord(launch(LIVE_AGENT, `rotate the ${FAKE_PAT} we leaked`)),
        42_000
      )
      const snapshots = await makeProvider().scan()
      const worker = snapshots[0]!.dwarfs[1]!
      expect(worker.name).toBe('rotate the [redacted] we leaked')
      expect(worker.description).toBe('rotate the [redacted] we leaked')
      expect(JSON.stringify(snapshots)).not.toContain(FAKE_PAT)
    })

    it('gives the relay the same redacted name the panel shows', async () => {
      // workerName becomes the '[for agent <name>] ' prefix a foreman reads,
      // and a human addresses a dwarf by the name they can SEE. Leaving the raw
      // description here would route messages under a name the panel never
      // shows — routing intact for the code, broken for the person.
      fake.addFile(
        `${ROOT1}\\projects\\${ENCODED}\\${SESSION_ID}.jsonl`,
        withLaunchRecord(launch(LIVE_AGENT, `rotate the ${FAKE_PAT} we leaked`)),
        42_000
      )
      const provider = makeProvider()
      const snapshots = await provider.scan()
      const worker = snapshots[0]!.dwarfs[1]!
      expect(provider.textDelivery(worker.id)).toEqual({
        kind: 'foreman-relay',
        foremanDwarfId: `claude:${SESSION_ID}`,
        workerName: 'rotate the [redacted] we leaked'
      })
      expect(provider.textDelivery(worker.id)).toMatchObject({ workerName: worker.name })
    })

    it('leaves the agent-id fallback name alone when a launch carries no description', async () => {
      // The fallback is built from the agent id, never from user text, so the
      // pass must not reach it — and an absent description must stay absent
      // rather than inheriting the fallback.
      const undescribed =
        JSON.stringify({
          type: 'user',
          toolUseResult: {
            isAsync: true,
            status: 'async_launched',
            agentId: LIVE_AGENT,
            resolvedModel: 'claude-fable-5'
          }
        }) + '\n'
      fake.addFile(
        `${ROOT1}\\projects\\${ENCODED}\\${SESSION_ID}.jsonl`,
        withLaunchRecord(undescribed),
        42_000
      )
      const provider = makeProvider()
      const snapshots = await provider.scan()
      const worker = snapshots[0]!.dwarfs[1]!
      expect(worker.name).toBe(`agent-${LIVE_AGENT.slice(0, 7)}`)
      expect(worker.description).toBeUndefined()
      expect(provider.textDelivery(worker.id)).toMatchObject({
        workerName: `agent-${LIVE_AGENT.slice(0, 7)}`
      })
    })
  })

  describe('pid-reuse guard', () => {
    /** session-entry.json's procStart ("134324755721362761") as epoch ms. */
    const REGISTRY_START_MS = 1_788_001_972_136

    function providerWithProbe(probe: (pid: number) => Promise<number | null>): ClaudeProvider {
      return new ClaudeProvider({
        fs: fake,
        roots: [ROOT1],
        isPidAlive: (pid) => alivePids.has(pid),
        processStartTimeMs: probe,
        now: () => 99_000
      })
    }

    it('drops a session whose pid now belongs to another process', async () => {
      // The registry file outlived its process and the OS handed 32896 to an
      // unrelated program: process.kill(pid, 0) still succeeds, but the real
      // creation time is nowhere near procStart. The dead session must vanish.
      const provider = providerWithProbe(async () => REGISTRY_START_MS + 60_000)
      expect(await provider.scan()).toEqual([])
      // The choke point: no snapshot means no delivery target either, so
      // focus/Send/Kick can never reach the recycled pid's window.
      expect(provider.textDelivery(`claude:${SESSION_ID}`)).toBeNull()
    })

    it('keeps a session whose probed start time matches within the tolerance', async () => {
      // POSIX probes are second-resolution (lstart) or 10ms ticks (/proc), so
      // a small skew against the FILETIME conversion is normal, not a reuse.
      const provider = providerWithProbe(async () => REGISTRY_START_MS + 1_500)
      expect(await provider.scan()).toHaveLength(1)
    })

    it('keeps the session when the probe answers null', async () => {
      // An unreadable process list is "unknown", and unknown must never make
      // things worse than today's kill(pid, 0) behavior: the dwarf stays.
      const provider = providerWithProbe(async () => null)
      expect(await provider.scan()).toHaveLength(1)
    })

    it('keeps the session when the probe throws', async () => {
      const provider = providerWithProbe(async () => {
        throw new Error('boom')
      })
      expect(await provider.scan()).toHaveLength(1)
    })

    it('keeps a session whose registry entry has no procStart', async () => {
      const entry: Record<string, unknown> = JSON.parse(sessionEntry)
      delete entry.procStart
      fake.addFile(`${ROOT1}\\sessions\\32896.json`, JSON.stringify(entry), 1_000)
      // A probe that would report a mismatch must never even be consulted:
      // there is nothing trustworthy to compare against.
      const probe = vi.fn(async () => REGISTRY_START_MS + 60_000)
      const provider = providerWithProbe(probe)
      expect(await provider.scan()).toHaveLength(1)
      expect(probe).not.toHaveBeenCalled()
    })

    it('keeps a session with an unparseable procStart without consulting the probe', async () => {
      const entry: Record<string, unknown> = JSON.parse(sessionEntry)
      entry.procStart = 'not-a-filetime'
      fake.addFile(`${ROOT1}\\sessions\\32896.json`, JSON.stringify(entry), 1_000)
      const probe = vi.fn(async () => REGISTRY_START_MS + 60_000)
      const provider = providerWithProbe(probe)
      expect(await provider.scan()).toHaveLength(1)
      expect(probe).not.toHaveBeenCalled()
    })

    it('probes each (pid, procStart) pair once, not once per poll tick', async () => {
      // The poller runs every 2s; a PowerShell spawn per session per tick
      // would dwarf the cost of the scan itself. The verdict is cached.
      const probe = vi.fn(async () => REGISTRY_START_MS)
      const provider = providerWithProbe(probe)
      await provider.scan()
      await provider.scan()
      expect(probe).toHaveBeenCalledTimes(1)
    })

    it('caches a mismatch verdict too, so a stale entry costs one probe total', async () => {
      const probe = vi.fn(async () => REGISTRY_START_MS + 60_000)
      const provider = providerWithProbe(probe)
      expect(await provider.scan()).toEqual([])
      expect(await provider.scan()).toEqual([])
      expect(probe).toHaveBeenCalledTimes(1)
    })

    it('re-probes after the pid dies, so a later recycle cannot ride a stale verdict', async () => {
      // Verified alive, then the process exits (kill starts failing), then the
      // OS recycles 32896. Without eviction the cached "match" would resurrect
      // the stale registry entry as a live dwarf — the exact bug being fixed.
      const probe = vi.fn(async () => REGISTRY_START_MS)
      const provider = providerWithProbe(probe)
      expect(await provider.scan()).toHaveLength(1)

      alivePids.clear()
      expect(await provider.scan()).toEqual([])
      expect(probe).toHaveBeenCalledTimes(1)

      alivePids.add(32896)
      await provider.scan()
      expect(probe).toHaveBeenCalledTimes(2)
    })

    it('changes nothing when no probe is wired at all', async () => {
      // makeProvider() has no processStartTimeMs — exactly today's behavior,
      // covered by every other test in this file. Pin it explicitly anyway.
      expect(await makeProvider().scan()).toHaveLength(1)
    })
  })

  describe('textDelivery', () => {
    it('has no channel before the first scan or for an unknown dwarf', async () => {
      const provider = makeProvider()
      expect(provider.textDelivery(`claude:${SESSION_ID}`)).toBeNull()
      await provider.scan()
      expect(provider.textDelivery('claude:nobody')).toBeNull()
    })

    it('types into the console of an interactive session, keeping its relay address', async () => {
      const provider = makeProvider()
      await provider.scan()
      // sessionName is the relay fallback address the runtime uses when the
      // console cannot be focused or typed into (issue #24).
      expect(provider.textDelivery(`claude:${SESSION_ID}`)).toEqual({
        kind: 'terminal',
        pid: 32896,
        sessionName: 'sample-project-70'
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
          name: 'sample-project-70'
        }),
        1_000
      )
      const provider = makeProvider()
      await provider.scan()
      expect(provider.textDelivery(`claude:${SESSION_ID}`)).toEqual({
        kind: 'claude-relay',
        sessionName: 'sample-project-70'
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

  /*
   * Issue #47 — this provider already reads each transcript's mtime for #40's
   * staleness rule and then threw the number away, so every heuristic the app
   * has operated entirely behind the user's back and the first sight of any of
   * it was a dwarf that had suddenly gone.
   *
   * Exposing the figure is not a new derivation: it is the same per-agent proof
   * of life, phrased as an age instead of a verdict. What matters here is WHOSE
   * proof of life each dwarf carries, and that a provider with no evidence says
   * so rather than guessing zero.
   */
  describe('per-dwarf silence (issue #47)', () => {
    const TRANSCRIPT = `${ROOT1}\\projects\\${ENCODED}\\${SESSION_ID}.jsonl`
    const SUBAGENT = `${ROOT1}\\projects\\${ENCODED}\\${SESSION_ID}\\subagents\\agent-${LIVE_AGENT}.jsonl`
    const MINUTE = 60_000

    /** The fixture crew, read with the clock the default fixtures were built around. */
    async function crewAtDefaultClock(): Promise<Dwarf[]> {
      return (await makeProvider().scan())[0]!.dwarfs
    }

    /** A provider whose only difference from makeProvider is where its clock stands. */
    function providerAt(now: number): ClaudeProvider {
      return new ClaudeProvider({
        fs: fake,
        roots: [ROOT1],
        isPidAlive: (pid) => alivePids.has(pid),
        now: () => now
      })
    }

    it('reports how long each dwarf has been silent, from its own transcript', async () => {
      // The fixtures: the clock stands at 99_000, the parent last wrote at
      // 42_000 and the worker's own subagent file at 43_000.
      const [foreman, worker] = await crewAtDefaultClock()
      expect(foreman!.silentForMs).toBe(57_000)
      expect(worker!.silentForMs).toBe(56_000)
    })

    it('measures a worker against its own transcript, never against its parent', async () => {
      // The whole point of the field: the app can say this about ONE specific,
      // identifiable agent. A worker still writing under a long-quiet foreman
      // must read as producing, and the reverse must read as silent.
      fake.addFile(TRANSCRIPT, parentTranscript, 10_000)
      fake.addFile(SUBAGENT, subagentTranscript, 98_000)
      const [foreman, worker] = await crewAtDefaultClock()
      expect(foreman!.silentForMs).toBe(89_000)
      expect(worker!.silentForMs).toBe(1_000)
    })

    it('reports nothing rather than zero when there is no per-agent evidence', async () => {
      // Codex has no equivalent per-subagent file, and a Claude worker whose
      // transcript has not appeared yet is the same case: undefined says "not
      // known", where 0 would claim the agent had just spoken.
      fake.removeFile(SUBAGENT)
      const [, worker] = await crewAtDefaultClock()
      expect(worker!.silentForMs).toBeUndefined()
      expect('silentForMs' in worker!).toBe(false)
    })

    it('never reports a negative age when the clock runs behind an mtime', async () => {
      // Clock skew and a filesystem timestamp are not the same measurement, so
      // "written in the future" has to floor at zero instead of rendering as
      // "no output for -3 minutes".
      fake.addFile(TRANSCRIPT, parentTranscript, 120_000)
      const [foreman] = await crewAtDefaultClock()
      expect(foreman!.silentForMs).toBe(0)
    })

    it('keeps a long-silent worker working: silence is never a fourth status', async () => {
      // THE constraint of #47. The ledger, the delivery channels and the
      // capability matrix all key off DwarfStatus, so a silence that leaked in
      // there would change what the app believes about the dwarf rather than
      // only what it shows. It stays a number beside an unchanged status.
      fake.addFile(SUBAGENT, subagentTranscript, 1_000)
      const provider = providerAt(1_000 + 45 * MINUTE)
      const worker = (await provider.scan())[0]!.dwarfs[1]!

      expect(worker.silentForMs).toBe(45 * MINUTE)
      expect(worker.status).toBe('working')
      expect(worker.role).toBe('worker')
      expect(provider.textDelivery(worker.id)).toMatchObject({ kind: 'foreman-relay' })
    })

    it('carries the figure on a foreman with no agents out at all', async () => {
      // A lone foreman is the shape a user watches most often, and it is the
      // one #40 judges by the hour rather than the half hour.
      fake.addFile(TRANSCRIPT, noAgentTranscript, 1_000)
      const dwarfs = (await providerAt(1_000 + 70 * MINUTE).scan())[0]!.dwarfs
      expect(dwarfs).toHaveLength(1)
      expect(dwarfs[0]).toMatchObject({ role: 'foreman', status: 'working' })
      expect(dwarfs[0]!.silentForMs).toBe(70 * MINUTE)
    })
  })
})
