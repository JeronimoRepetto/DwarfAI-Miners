import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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
     */
    describe('stale launch memory (issue #40)', () => {
      const SUBAGENT = `${ROOT1}\\projects\\${ENCODED}\\${SESSION_ID}\\subagents\\agent-${LIVE_AGENT}.jsonl`
      /** Short enough to read at a glance; the product default is minutes. */
      const WINDOW = 10_000
      /** When both transcripts were last written, before each test moves on. */
      const LAST_WRITE = 42_000

      let clock = LAST_WRITE

      /**
       * The provider with the clock this describe drives and a window small
       * enough to cross inside a test. `staleLaunchMs` omitted entirely — see
       * the last test — is what exercises the product default.
       */
      function staleAwareProvider(staleLaunchMs = WINDOW): ClaudeProvider {
        return new ClaudeProvider({
          fs: fake,
          roots: [ROOT1],
          isPidAlive: (pid) => alivePids.has(pid),
          now: () => clock,
          staleLaunchMs
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
        // ever arrive and neither transcript is written again. A whole window
        // of that is the parent proving nothing is running.
        clock = LAST_WRITE + WINDOW
        const second = await provider.scan()
        expect(second[0]!.status).toBe('idle')
        expect(second[0]!.dwarfs).toEqual([])
      })

      it('keeps the worker one millisecond before the window has elapsed', async () => {
        clock = LAST_WRITE + WINDOW - 1
        const snapshots = await staleAwareProvider().scan()
        expect(snapshots[0]!.dwarfs.map((d) => d.id)).toEqual([MAIN_ID, WORKER_ID])
      })

      it('drops the worker the moment the window has exactly elapsed', async () => {
        clock = LAST_WRITE + WINDOW
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
        clock = LAST_WRITE + WINDOW * 100
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

        clock = LAST_WRITE + WINDOW * 100
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

        // The parent has been quiet for three windows; the worker wrote a
        // moment ago.
        clock = LAST_WRITE + WINDOW * 3
        fake.addFile(SUBAGENT, subagentTranscript, clock - 1)
        expect((await provider.scan())[0]!.dwarfs.map((d) => d.id)).toEqual([MAIN_ID, WORKER_ID])

        // ...and is still writing when the session picks up a turn again.
        clock += WINDOW * 3
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
        clock = LAST_WRITE + WINDOW
        expect((await provider.scan())[0]!.dwarfs).toEqual([])

        // Next morning the user types a new prompt. The dead agent's launch
        // record is STILL in the tail — nothing has scrolled it out — so a rule
        // that only re-derived staleness each poll would re-adopt it and the
        // ghost would be back the moment the session resumed.
        fake.addFile(`${ROOT1}\\sessions\\32896.json`, entryWithStatus('busy'), 2_000)
        clock += WINDOW
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

        clock = LAST_WRITE + WINDOW
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

      it('uses a generous default window when none is injected', async () => {
        // Ten minutes of silence is not proof: a subagent grinding through one
        // long tool call writes nothing at all until that call returns. The
        // default has to be long enough that only a truly dead agent trips it,
        // so this is the one provider here with no window injected at all.
        const provider = new ClaudeProvider({
          fs: fake,
          roots: [ROOT1],
          isPidAlive: (pid) => alivePids.has(pid),
          now: () => clock
        })
        clock = LAST_WRITE + 10 * 60_000
        const snapshots = await provider.scan()
        expect(snapshots[0]!.dwarfs.map((d) => d.id)).toEqual([MAIN_ID, WORKER_ID])
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
})
