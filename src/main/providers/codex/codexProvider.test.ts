import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeFs } from '../../adapters/fakeFs'
import { CODEX_PROBE_SCRIPT } from '../../platform/processProbe'
import {
  CodexProvider,
  codexDebugEnabled,
  formatCodexSkip,
  type CodexProviderOptions
} from './codexProvider'
import type { ProviderSnapshot } from '../../domain/types'
import { extractCodexFeed } from './parse'

const FIXTURES = join(import.meta.dirname, '..', '__fixtures__', 'codex')
const rollout = readFileSync(join(FIXTURES, 'rollout.jsonl'), 'utf8')
const rolloutLines = rollout.split('\n').filter(Boolean)
/** Same rollout with the final task_complete missing: the turn is still open. */
const busyRollout = rolloutLines.slice(0, rolloutLines.length - 1).join('\n') + '\n'

const ROOT = 'C:\\Users\\j\\.codex\\sessions'
const SESSION_ID = '01a048b5-5f35-7312-ab78-38db464920de'
const BUSY_SESSION_ID = '01a048b5-0000-7312-ab78-000000000000'
/** A rollout whose conversation sits behind a turn's worth of tool output (#228). */
const BURIED_SESSION_ID = '01a048b5-1111-7312-ab78-111111111111'

// Local noon on 2026-08-29; "yesterday" is 2026-08-28.
const NOW = new Date(2026, 7, 29, 12, 0, 0).getTime()
const WINDOW_S = 600

describe('CODEX_PROBE_SCRIPT', () => {
  // The probing powershell.exe's own CommandLine contains the query text
  // (and therefore "codex"); without these guards the probe matches itself
  // and reports codex as running unconditionally.
  it('excludes the probe process itself and every PowerShell host', () => {
    expect(CODEX_PROBE_SCRIPT).toContain('$_.ProcessId -ne $PID')
    expect(CODEX_PROBE_SCRIPT).toContain("$_.Name -notmatch '^(powershell|pwsh)'")
  })

  it('still matches codex by process name or command line', () => {
    expect(CODEX_PROBE_SCRIPT).toContain("$_.Name -match 'codex'")
    expect(CODEX_PROBE_SCRIPT).toContain("$_.CommandLine -match 'codex'")
  })
})

function busyLines(): string {
  return busyRollout
    .replaceAll(SESSION_ID, BUSY_SESSION_ID)
    .replaceAll('Sample-Project', 'Busy-Project')
}

function largeBusyRollout(): string {
  const head = rolloutLines.slice(0, 3).join('\n')
  const padding = JSON.stringify({
    type: 'response_item',
    payload: { type: 'reasoning', encrypted_content: 'x'.repeat(300_000) }
  })
  const taskStarted = JSON.stringify({
    type: 'event_msg',
    payload: { type: 'task_started', turn_id: 'large-turn' }
  })
  return `${head}\n${padding}\n${taskStarted}\n`
}

/**
 * Reproduces the real-world tail-window bug: a turn_started event followed by
 * a large amount of output (tool results, reasoning) with no task_complete
 * yet. On a real machine rollout the observed gap between task_started and
 * its eventual task_complete was 347,167 bytes (2026-08-29 agent-name
 * session) — well past a 256KB tail read, which would make an in-progress
 * turn look idle.
 */
function openTurnPushedOutOfTailRollout(): string {
  const head = rolloutLines.slice(0, 3).join('\n')
  const taskStarted = JSON.stringify({
    type: 'event_msg',
    payload: { type: 'task_started', turn_id: 'still-open-turn' }
  })
  const padding = JSON.stringify({
    type: 'response_item',
    payload: { type: 'reasoning', encrypted_content: 'x'.repeat(300_000) }
  })
  return `${head}\n${taskStarted}\n${padding}\n`
}

/** The window CodexProvider.feed used to be fixed at, and the walk's first step. */
const POLL_FEED_WINDOW_BYTES = 256 * 1024

/**
 * One rollout record of tool output, `bytes` of it: the currency a rollout is
 * mostly made of, and what a feed read has to get past to reach the words.
 * `function_call_output` is what a real shell or apply_patch call writes back.
 */
function toolOutputRecord(bytes: number): string {
  return JSON.stringify({
    timestamp: '2026-08-29T11:30:00.000Z',
    type: 'response_item',
    payload: { type: 'function_call_output', call_id: 'call_01', output: 'x'.repeat(bytes) }
  })
}

/** The fixture's finished conversation, then `trailing` bytes of a later turn. */
function rolloutWithTrailingNoise(trailing: string): string {
  return rollout.replaceAll(SESSION_ID, BURIED_SESSION_ID) + trailing
}

function withThreadSpawn(rolloutText: string, parentSessionId: string, agentName: string): string {
  const lines = rolloutText.split('\n').filter(Boolean)
  const sessionMeta: { payload: Record<string, unknown> } = JSON.parse(lines[0]!)
  sessionMeta.payload.source = {
    subagent: { thread_spawn: { parent_thread_id: parentSessionId, agent_nickname: agentName } }
  }
  lines[0] = JSON.stringify(sessionMeta)
  return lines.join('\n') + '\n'
}

describe('CodexProvider', () => {
  let fake: FakeFs

  function makeProvider(overrides: Partial<CodexProviderOptions> = {}): CodexProvider {
    return new CodexProvider({
      fs: fake,
      sessionsRoot: ROOT,
      livenessWindowS: WINDOW_S,
      scanDays: 7,
      // Retention is additive to livenessWindowS; 0 extra seconds by default so
      // no test hits the process probe unless it opts in explicitly (opting in
      // also needs a fake isCodexProcessRunning).
      idleRetentionS: 0,
      now: () => NOW,
      ...overrides
    })
  }

  beforeEach(() => {
    fake = new FakeFs()
    // finished rollout from today, fresh mtime
    fake.addFile(
      `${ROOT}\\2026\\08\\29\\rollout-2026-08-29T11-00-00-${SESSION_ID}.jsonl`,
      rollout,
      NOW - 60_000
    )
    // busy rollout from yesterday, fresh mtime
    fake.addFile(
      `${ROOT}\\2026\\08\\28\\rollout-2026-08-28T23-59-00-${BUSY_SESSION_ID}.jsonl`,
      busyLines(),
      NOW - 120_000
    )
  })

  it('has kind codex', () => {
    expect(makeProvider().kind).toBe('codex')
  })

  it('detects fresh rollouts from today and yesterday', async () => {
    const snapshots = await makeProvider().scan()
    expect(snapshots.map((s) => s.sessionId).sort()).toEqual([BUSY_SESSION_ID, SESSION_ID])
  })

  /**
   * AMENDED for #202 (was: "maps a completed last turn to an idle snapshot with
   * no dwarfs"). The snapshot status is unchanged — no turn is open — but the
   * `dwarfs: []` it used to assert was the defect itself: a Codex session the
   * scan still reports is a session a human is sitting in front of between
   * turns, and deleting its dwarf at task_complete is what made the same dwarf
   * leave, return, and be placed somewhere else on every prompt. Only its
   * STATUS may move. The doc named this test as one taught to agree with the
   * defect (docs/session-topology-and-roles.md).
   */
  it('maps a completed last turn to an idle snapshot whose dwarf rests in place', async () => {
    const snapshots = await makeProvider().scan()
    const idle = snapshots.find((s) => s.sessionId === SESSION_ID)!
    expect(idle.status).toBe('idle')
    expect(idle.dwarfs).toHaveLength(1)
    expect(idle.dwarfs[0]).toMatchObject({
      id: `codex:${SESSION_ID}`,
      provider: 'codex',
      status: 'waiting',
      sessionId: SESSION_ID
    })
    expect(idle.cwd).toBe('C:\\Users\\j\\Desktop\\Sample-Project')
    expect(idle.updatedAt).toBe(NOW - 60_000)
  })

  /**
   * AMENDED for #202 (was: "…with a single worker dwarf"). The role assertion
   * stands and is the point: 'worker' here records that no child edge has ever
   * been observed for this session, which is the absence of evidence — it is no
   * longer a verdict recomputed from how many children are busy this scan. The
   * doc named this test too (it pins a standalone busy Codex session as a
   * worker); what it pinned by accident it now pins on purpose.
   */
  it('maps an open turn to a busy snapshot with one dwarf no child edge has ranked', async () => {
    const snapshots = await makeProvider().scan()
    const busy = snapshots.find((s) => s.sessionId === BUSY_SESSION_ID)!
    expect(busy.status).toBe('busy')
    expect(busy.cwd).toBe('C:\\Users\\j\\Desktop\\Busy-Project')
    expect(busy.dwarfs).toHaveLength(1)
    expect(busy.dwarfs[0]).toMatchObject({
      id: `codex:${BUSY_SESSION_ID}`,
      provider: 'codex',
      role: 'worker',
      model: 'gpt-5.6-sol',
      effort: 'high',
      status: 'working',
      lastMessage: 'Latest codex reply placeholder.',
      sessionId: BUSY_SESSION_ID
    })
  })

  /**
   * AMENDED for #202 (was: "…to an idle snapshot with no dwarfs"). Issue #34's
   * subject is untouched and still asserted: an aborted turn must stop the
   * dwarf MINING. What changed is that stopping work is not leaving the mine —
   * the session is still there, at the prompt, so the dwarf rests instead of
   * disappearing.
   */
  it('maps a user-aborted turn to an idle snapshot whose dwarf stops mining (issue #34)', async () => {
    // Esc mid-turn: task_started stays unmatched by any task_complete, but the
    // structured turn_aborted record proves the turn is over. Without it the
    // dwarf keeps mining forever even though the agent sits at the prompt.
    const abortedLines =
      busyLines() +
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'turn_aborted',
          turn_id: '01a048b5-71aa-7900-88b5-d3842c3c2697',
          reason: 'interrupted'
        }
      }) +
      '\n'
    fake.addFile(
      `${ROOT}\\2026\\08\\28\\rollout-2026-08-28T23-59-00-${BUSY_SESSION_ID}.jsonl`,
      abortedLines,
      NOW - 120_000
    )

    const snapshots = await makeProvider().scan()
    const aborted = snapshots.find((snapshot) => snapshot.sessionId === BUSY_SESSION_ID)!
    expect(aborted.status).toBe('idle')
    expect(aborted.dwarfs).toHaveLength(1)
    expect(aborted.dwarfs[0]).toMatchObject({
      id: `codex:${BUSY_SESSION_ID}`,
      status: 'waiting'
    })
  })

  it('falls back to head context when a large turn pushes it outside the tail read', async () => {
    const largeSessionId = '01a048b5-large-7312-ab78-000000000000'
    fake.addFile(
      `${ROOT}\\2026\\08\\29\\rollout-2026-08-29T11-30-00-${largeSessionId}.jsonl`,
      largeBusyRollout().replaceAll(SESSION_ID, largeSessionId),
      NOW - 30_000
    )

    const snapshots = await makeProvider().scan()
    const large = snapshots.find((snapshot) => snapshot.sessionId === largeSessionId)!
    expect(large).toMatchObject({ status: 'busy' })
    expect(large.dwarfs[0]).toMatchObject({
      model: 'gpt-5.6-sol',
      effort: 'high',
      status: 'working'
    })
  })

  it('stays busy when a large in-progress turn pushes task_started outside a 256KB tail read', async () => {
    const pushedOutSessionId = '01a048b5-pushedout-7312-ab78-000000000000'
    fake.addFile(
      `${ROOT}\\2026\\08\\29\\rollout-2026-08-29T11-33-00-${pushedOutSessionId}.jsonl`,
      openTurnPushedOutOfTailRollout().replaceAll(SESSION_ID, pushedOutSessionId),
      NOW - 5_000
    )

    const snapshots = await makeProvider().scan()
    const pushedOut = snapshots.find((snapshot) => snapshot.sessionId === pushedOutSessionId)!
    expect(pushedOut.status).toBe('busy')
    expect(pushedOut.dwarfs).toHaveLength(1)
    expect(pushedOut.dwarfs[0]).toMatchObject({ status: 'working' })
  })

  /**
   * AMENDED for #202 (was: "…and promote its observed parent"). There is no
   * promotion left to name: the parent is not raised while its child happens to
   * be busy, it is a foreman because a child edge was read for it — a fact
   * about the tree, not about this scan's headcount. The assertions are the
   * same ones; what they mean changed, and the doc flagged this test as
   * carrying the old meaning. The edge outliving the child's turn is pinned
   * separately, in the #202 block at the end of this file.
   */
  it('uses explicit Codex thread_spawn data to name a worker and make its parent a foreman', async () => {
    const parentSessionId = '01a048b5-parent-7312-ab78-000000000000'
    const childSessionId = '01a048b5-child-7312-ab78-000000000000'
    fake.addFile(
      `${ROOT}\\2026\\08\\29\\rollout-2026-08-29T11-31-00-${parentSessionId}.jsonl`,
      busyLines().replaceAll(BUSY_SESSION_ID, parentSessionId),
      NOW - 20_000
    )
    fake.addFile(
      `${ROOT}\\2026\\08\\29\\rollout-2026-08-29T11-32-00-${childSessionId}.jsonl`,
      withThreadSpawn(
        busyLines().replaceAll(BUSY_SESSION_ID, childSessionId),
        parentSessionId,
        'Focused worker'
      ),
      NOW - 10_000
    )

    const snapshots = await makeProvider().scan()
    const parent = snapshots.find((snapshot) => snapshot.sessionId === parentSessionId)!
    const child = snapshots.find((snapshot) => snapshot.sessionId === childSessionId)!
    expect(parent.dwarfs[0]).toMatchObject({ role: 'foreman', sessionId: parentSessionId })
    expect(child.dwarfs[0]).toMatchObject({ role: 'worker', name: 'Focused worker' })
  })

  it('finds a fresh rollout in a day directory older than yesterday (session opened days ago, still active)', async () => {
    const oldDirSessionId = '01a048b5-olddir-7312-ab78-000000000000'
    // Rollout directories are named by the session's START date, which can be
    // arbitrarily older than "today" while the session itself is still live
    // (fresh mtime). Scanning only today+yesterday would miss this entirely.
    fake.addFile(
      `${ROOT}\\2026\\08\\24\\rollout-2026-08-24T09-00-00-${oldDirSessionId}.jsonl`,
      rollout.replaceAll(SESSION_ID, oldDirSessionId),
      NOW - 5_000
    )
    const snapshots = await makeProvider().scan()
    expect(snapshots.map((s) => s.sessionId)).toContain(oldDirSessionId)
  })

  it('does not scan beyond the configured scanDays window', async () => {
    const tooOldDirSessionId = '01a048b5-tooold-7312-ab78-000000000000'
    fake.addFile(
      `${ROOT}\\2026\\08\\01\\rollout-2026-08-01T09-00-00-${tooOldDirSessionId}.jsonl`,
      rollout.replaceAll(SESSION_ID, tooOldDirSessionId),
      NOW - 5_000
    )
    const snapshots = await makeProvider({ scanDays: 7 }).scan()
    expect(snapshots.map((s) => s.sessionId)).not.toContain(tooOldDirSessionId)
  })

  describe('scanDays boundary (off-by-one)', () => {
    // NOW is local noon on 2026-08-29 with scanDays: 7, so the loop visits
    // daysAgo 0..6 (today back to 2026-08-23 inclusive) and must stop there:
    // 2026-08-22 (daysAgo 7) is exactly one day past the window.
    it('scans the oldest day directory still inside the window (daysAgo = scanDays - 1)', async () => {
      const oldestInWindowSessionId = '01a048b5-oldestin-7312-ab78-000000000000'
      fake.addFile(
        `${ROOT}\\2026\\08\\23\\rollout-2026-08-23T09-00-00-${oldestInWindowSessionId}.jsonl`,
        rollout.replaceAll(SESSION_ID, oldestInWindowSessionId),
        NOW - 5_000
      )
      const snapshots = await makeProvider({ scanDays: 7 }).scan()
      expect(snapshots.map((s) => s.sessionId)).toContain(oldestInWindowSessionId)
    })

    it('excludes the day directory exactly scanDays days ago (daysAgo = scanDays)', async () => {
      const oneDayTooOldSessionId = '01a048b5-onedaytoo-7312-ab78-000000000000'
      fake.addFile(
        `${ROOT}\\2026\\08\\22\\rollout-2026-08-22T09-00-00-${oneDayTooOldSessionId}.jsonl`,
        rollout.replaceAll(SESSION_ID, oneDayTooOldSessionId),
        NOW - 5_000
      )
      const snapshots = await makeProvider({ scanDays: 7 }).scan()
      expect(snapshots.map((s) => s.sessionId)).not.toContain(oneDayTooOldSessionId)
    })
  })

  it('keeps a quiet rollout visible past the liveness window while a codex process is running', async () => {
    const quietSessionId = '01a048b5-quiet-7312-ab78-000000000000'
    fake.addFile(
      `${ROOT}\\2026\\08\\29\\rollout-2026-08-29T09-00-00-${quietSessionId}.jsonl`,
      rollout.replaceAll(SESSION_ID, quietSessionId),
      // Past livenessWindowS (600s) but inside livenessWindowS + idleRetentionS.
      NOW - (WINDOW_S + 120) * 1_000
    )
    const snapshots = await makeProvider({
      idleRetentionS: 3600,
      isCodexProcessRunning: async () => true
    }).scan()
    expect(snapshots.map((s) => s.sessionId)).toContain(quietSessionId)
  })

  it('drops a quiet rollout past the liveness window when no codex process is running', async () => {
    const quietSessionId = '01a048b5-noproc-7312-ab78-000000000000'
    fake.addFile(
      `${ROOT}\\2026\\08\\29\\rollout-2026-08-29T09-00-00-${quietSessionId}.jsonl`,
      rollout.replaceAll(SESSION_ID, quietSessionId),
      NOW - (WINDOW_S + 120) * 1_000
    )
    const snapshots = await makeProvider({
      idleRetentionS: 3600,
      isCodexProcessRunning: async () => false
    }).scan()
    expect(snapshots.map((s) => s.sessionId)).not.toContain(quietSessionId)
  })

  it('drops a rollout past even the extended idle retention window regardless of the process check', async () => {
    const staleSessionId = '01a048b5-stale-7312-ab78-000000000000'
    fake.addFile(
      `${ROOT}\\2026\\08\\29\\rollout-2026-08-29T01-00-00-${staleSessionId}.jsonl`,
      rollout.replaceAll(SESSION_ID, staleSessionId),
      // Past livenessWindowS + idleRetentionS (600 + 3600 = 4200s).
      NOW - 4_300 * 1_000
    )
    const snapshots = await makeProvider({
      idleRetentionS: 3600,
      isCodexProcessRunning: async () => true
    }).scan()
    expect(snapshots.map((s) => s.sessionId)).not.toContain(staleSessionId)
  })

  it('keeps a rollout inside the liveness window even when idleRetentionS is smaller than livenessWindowS', async () => {
    // Regression: retention is additive, so a small retention value must never
    // shrink the liveness window itself (min(liveness, retention) was a bug).
    const insideWindowSessionId = '01a048b5-nside-7312-ab78-000000000000'
    fake.addFile(
      `${ROOT}\\2026\\08\\29\\rollout-2026-08-29T10-55-00-${insideWindowSessionId}.jsonl`,
      rollout.replaceAll(SESSION_ID, insideWindowSessionId),
      NOW - Math.floor(WINDOW_S / 2) * 1_000
    )
    const probe = vi.fn(async () => false)
    const snapshots = await makeProvider({
      idleRetentionS: 60,
      isCodexProcessRunning: probe
    }).scan()
    expect(snapshots.map((s) => s.sessionId)).toContain(insideWindowSessionId)
    expect(probe).not.toHaveBeenCalled()
  })

  it('never calls isCodexProcessRunning when every rollout is already within the liveness window', async () => {
    const probe = vi.fn(async () => true)
    await makeProvider({ isCodexProcessRunning: probe }).scan()
    expect(probe).not.toHaveBeenCalled()
  })

  it('skips rollouts whose mtime is outside the liveness window', async () => {
    fake.addFile(
      `${ROOT}\\2026\\08\\29\\rollout-2026-08-29T01-00-00-01a04444-aaaa-7312-ab78-000000000001.jsonl`,
      rollout,
      NOW - (WINDOW_S + 5) * 1_000
    )
    const snapshots = await makeProvider().scan()
    expect(snapshots.map((s) => s.sessionId).sort()).toEqual([BUSY_SESSION_ID, SESSION_ID])
  })

  it('ignores files that are not rollout jsonl files', async () => {
    fake.addFile(`${ROOT}\\2026\\08\\29\\notes.txt`, 'hello', NOW)
    const snapshots = await makeProvider().scan()
    expect(snapshots).toHaveLength(2)
  })

  it('returns [] when the sessions root does not exist', async () => {
    fake = new FakeFs()
    expect(await makeProvider().scan()).toEqual([])
  })

  it('skips rollouts without a parseable session_meta', async () => {
    fake.addFile(
      `${ROOT}\\2026\\08\\29\\rollout-2026-08-29T10-00-00-01a04444-bbbb-7312-ab78-000000000002.jsonl`,
      '{"type":"event_msg","payload":{"type":"task_started"}}\n',
      NOW - 1_000
    )
    const snapshots = await makeProvider().scan()
    expect(snapshots).toHaveLength(2)
  })

  describe('feed', () => {
    it('returns the rollout feed for a scanned dwarf', async () => {
      const provider = makeProvider()
      await provider.scan()
      const feed = await provider.feed(`codex:${BUSY_SESSION_ID}`, 20)
      expect(feed!.map((m) => m.role)).toEqual(['user', 'assistant'])
    })

    it('returns null for an unknown dwarf id', async () => {
      const provider = makeProvider()
      await provider.scan()
      expect(await provider.feed('codex:nope', 20)).toBeNull()
    })

    /**
     * #192: a rollout that ages out of the liveness window is no longer a
     * session, but it is still a file, and the last turn is in it. The panel
     * reads once more as the dwarf leaves, which needs the path to survive
     * the scan that stopped reporting it. The queue address does not survive
     * (see queueTargets): a message must not be queued for a thread that ended.
     */
    it('still reads the rollout of a session that has aged out of the liveness window', async () => {
      let clock = NOW
      const provider = makeProvider({ now: () => clock })
      await provider.scan()

      clock = NOW + (WINDOW_S + 60) * 1_000
      const later = await provider.scan()
      expect(later.map((s) => s.sessionId)).not.toContain(BUSY_SESSION_ID)

      const feed = await provider.feed(`codex:${BUSY_SESSION_ID}`, 20)
      expect(feed!.map((m) => m.role)).toEqual(['user', 'assistant'])
      expect(provider.textDelivery(`codex:${BUSY_SESSION_ID}`)).toBeNull()
    })

    /**
     * #228, the Codex half of #188: feed() read a fixed 256 KiB tail, so a
     * conversation with one turn's worth of tool output behind it was outside
     * the window by construction rather than by chance. 4 KiB of
     * function_call_output per record, 80 of them — 320 KiB of traffic after
     * the only two lines a person wanted to read.
     */
    it('reaches past the poll window for a conversation buried in tool output', async () => {
      const noise = Array.from({ length: 80 }, () => toolOutputRecord(4 * 1024)).join('\n')
      fake.addFile(
        `${ROOT}\\2026\\08\\29\\rollout-2026-08-29T11-30-00-${BURIED_SESSION_ID}.jsonl`,
        rolloutWithTrailingNoise(noise + '\n'),
        NOW - 30_000
      )

      const provider = makeProvider()
      await provider.scan()
      const feed = await provider.feed(`codex:${BURIED_SESSION_ID}`, 20)
      expect(feed!.map((m) => m.text)).toEqual([
        'Placeholder plain message.',
        'Placeholder text block.'
      ])
    })

    /**
     * The escalation question a rollout answers differently from a transcript
     * (#228): the walk stops when a window comes back short of the bytes it
     * asked for, and a byte-offset tail can open in the middle of a rollout
     * line. `jsonlRecords` drops that fragment, so the narrow window does not
     * show half a message — it loses the message. This sizes the tool output
     * so the 256 KiB boundary falls 40 bytes before a user line ends, then
     * pins both halves of the claim: the narrow window really does lose it,
     * and the walk really does bring it back whole.
     */
    it('brings back whole a user message the poll window opened in the middle of', async () => {
      const path = `${ROOT}\\2026\\08\\29\\rollout-2026-08-29T11-31-00-${BURIED_SESSION_ID}.jsonl`
      const userLine = JSON.stringify({
        timestamp: '2026-08-29T11:31:00.000Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: 'The question the poll window cut in half.' }
      })
      const assistantLine = JSON.stringify({
        timestamp: '2026-08-29T11:32:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'The answer that survived it.' }]
        }
      })
      const fill =
        POLL_FEED_WINDOW_BYTES -
        40 -
        Buffer.byteLength(toolOutputRecord(0), 'utf8') -
        Buffer.byteLength(assistantLine, 'utf8') -
        2
      fake.addFile(
        path,
        rolloutWithTrailingNoise(`${userLine}\n${toolOutputRecord(fill)}\n${assistantLine}\n`),
        NOW - 30_000
      )

      // The fragment is unparseable JSON, so the 256 KiB window answers with
      // the reply alone and no trace of the question it answers.
      const pollWindow = await fake.readTextTail(path, POLL_FEED_WINDOW_BYTES)
      expect(pollWindow.startsWith('{')).toBe(false)
      expect(extractCodexFeed(pollWindow, 20).map((m) => m.text)).toEqual([
        'The answer that survived it.'
      ])

      const provider = makeProvider()
      await provider.scan()
      const feed = await provider.feed(`codex:${BURIED_SESSION_ID}`, 20)
      expect(feed!.map((m) => m.text)).toEqual([
        'Placeholder plain message.',
        'Placeholder text block.',
        'The question the poll window cut in half.',
        'The answer that survived it.'
      ])
    })

    /**
     * The other half of that question (#228): a rollout smaller than the
     * narrowest window comes back whole on the first read, so a short answer
     * already proves the read reached the start and the walk must stop there.
     * Asserted on the read count, because "it returned the right messages" is
     * equally true of a walk that paid for two more windows first.
     */
    it('reads a small rollout once, because the first window already reached its start', async () => {
      const provider = makeProvider()
      await provider.scan()

      const tailSpy = vi.spyOn(fake, 'readTextTail')
      const feed = await provider.feed(`codex:${SESSION_ID}`, 20)
      expect(feed!.map((m) => m.role)).toEqual(['user', 'assistant'])
      expect(tailSpy.mock.calls.length).toBe(1)
    })
  })

  describe('secret redaction at the provider boundary', () => {
    // Fixture-shaped fake, never a real credential.
    const FAKE_TOKEN = 'xoxb-1234567890-1234567890123-FAKEFAKEFAKEFAKEFAKEFAKE'

    it('redacts a pasted token out of the busy dwarf lastMessage', async () => {
      const agentMessage =
        JSON.stringify({
          type: 'event_msg',
          timestamp: '2026-08-29T11:59:00.000Z',
          payload: { type: 'agent_message', message: `Set the bot token to ${FAKE_TOKEN}.` }
        }) + '\n'
      fake.addFile(
        `${ROOT}\\2026\\08\\28\\rollout-2026-08-28T23-59-00-${BUSY_SESSION_ID}.jsonl`,
        busyLines() + agentMessage,
        NOW - 120_000
      )
      const snapshots = await makeProvider().scan()
      const busy = snapshots.find((s) => s.sessionId === BUSY_SESSION_ID)!
      expect(busy.dwarfs[0]!.lastMessage).toBe('Set the bot token to [redacted].')
    })

    it('redacts user and assistant feed messages alike', async () => {
      const userMessage =
        JSON.stringify({
          type: 'event_msg',
          timestamp: '2026-08-29T11:58:00.000Z',
          payload: { type: 'user_message', message: `here is ${FAKE_TOKEN} for slack` }
        }) + '\n'
      fake.addFile(
        `${ROOT}\\2026\\08\\28\\rollout-2026-08-28T23-59-00-${BUSY_SESSION_ID}.jsonl`,
        busyLines() + userMessage,
        NOW - 120_000
      )
      const provider = makeProvider()
      await provider.scan()
      const feed = await provider.feed(`codex:${BUSY_SESSION_ID}`, 20)
      expect(feed!.map((m) => m.text)).toContain('here is [redacted] for slack')
      expect(JSON.stringify(feed)).not.toContain(FAKE_TOKEN)
    })
  })

  /**
   * Regression (issue #12): scan() used to clear() the shared feedSources map
   * and repopulate it across awaits, so a click landing mid-scan read a
   * half-rebuilt map. The map must be built off to the side and swapped in
   * atomically at the end of the scan.
   */
  describe('feed sources during a concurrent scan', () => {
    /** Suspends the next rollout read and resolves once the scan is parked there. */
    function gateNextRolloutRead(): { reached: Promise<void>; release: () => void } {
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
      const busyId = `codex:${BUSY_SESSION_ID}`
      const settled = provider.transcriptPath(busyId)
      expect(settled).toContain(BUSY_SESSION_ID)

      const gate = gateNextRolloutRead()
      const scanning = provider.scan()
      await gate.reached

      expect(provider.transcriptPath(busyId)).toBe(settled)
      expect((await provider.feed(busyId, 20))!.length).toBeGreaterThan(0)

      gate.release()
      await scanning
      expect(provider.transcriptPath(busyId)).toBe(settled)
    })

    it('never resolves a dwarf id to another session rollout mid-scan', async () => {
      const provider = makeProvider()
      await provider.scan()
      const idleId = `codex:${SESSION_ID}`
      const idlePath = provider.transcriptPath(idleId)
      expect(idlePath).toContain(SESSION_ID)

      const gate = gateNextRolloutRead()
      const scanning = provider.scan()
      await gate.reached

      const midScan = provider.transcriptPath(idleId)
      expect(midScan).toBe(idlePath)
      expect(midScan).not.toContain(BUSY_SESSION_ID)

      gate.release()
      await scanning
    })
  })

  /**
   * R3-busy-tail-cost: BUSY_TAIL_BYTES (4MiB) is the expensive read per
   * rollout per scan. A rollout that hasn't grown since the previous scan is
   * append-only, so its content (and therefore its busy/model/lastMessage
   * verdict) cannot have changed — the previous read can be reused instead of
   * paying that read again.
   */
  describe('busy-tail read caching', () => {
    it('skips the busy-tail read for a rollout whose size is unchanged since the previous scan', async () => {
      const tailSpy = vi.spyOn(fake, 'readTextTail')
      const provider = makeProvider()

      await provider.scan()
      const afterFirstScan = tailSpy.mock.calls.length
      expect(afterFirstScan).toBeGreaterThan(0)

      await provider.scan() // nothing changed on disk
      expect(tailSpy.mock.calls.length).toBe(afterFirstScan)
    })

    it('re-reads the busy tail once a rollout actually grows', async () => {
      const tailSpy = vi.spyOn(fake, 'readTextTail')
      const provider = makeProvider()
      await provider.scan()
      const afterFirstScan = tailSpy.mock.calls.length

      fake.addFile(
        `${ROOT}\\2026\\08\\28\\rollout-2026-08-28T23-59-00-${BUSY_SESSION_ID}.jsonl`,
        busyLines() + '\n',
        NOW - 120_000
      )
      await provider.scan()
      expect(tailSpy.mock.calls.length).toBe(afterFirstScan + 1)
    })

    it('keeps reporting the correct busy/idle status when reusing a cached parse', async () => {
      const provider = makeProvider()
      await provider.scan()
      const second = await provider.scan()
      expect(second.find((s) => s.sessionId === SESSION_ID)?.status).toBe('idle')
      expect(second.find((s) => s.sessionId === BUSY_SESSION_ID)?.status).toBe('busy')
    })
  })

  /**
   * R3-probe-spawn-per-tick: isCodexProcessRunning() spawns powershell.exe.
   * scan() already memoizes it to at most one call per tick, but a session
   * stuck in the "past freshAfter, still inside retainAfter" band would
   * otherwise re-spawn it on every 2s tick for as long as it stays quiet.
   */
  describe('process probe caching', () => {
    it('reuses the isCodexProcessRunning verdict across scans within the TTL, then re-probes once it expires', async () => {
      const quietSessionId = '01a048b5-probettl-7312-ab78-000000000000'
      fake.addFile(
        `${ROOT}\\2026\\08\\29\\rollout-2026-08-29T09-00-00-${quietSessionId}.jsonl`,
        rollout.replaceAll(SESSION_ID, quietSessionId),
        // Past livenessWindowS (600s) but inside livenessWindowS + idleRetentionS,
        // so every scan below needs the process probe to decide.
        NOW - (WINDOW_S + 120) * 1_000
      )
      let currentNow = NOW
      const probe = vi.fn(async () => true)
      const provider = makeProvider({
        idleRetentionS: 3600,
        isCodexProcessRunning: probe,
        processProbeCacheTtlS: 15,
        now: () => currentNow
      })

      await provider.scan()
      expect(probe).toHaveBeenCalledTimes(1)

      currentNow += 5_000 // well inside the 15s TTL
      await provider.scan()
      expect(probe).toHaveBeenCalledTimes(1)

      currentNow += 11_000 // 16s since the first probe: past the TTL
      await provider.scan()
      expect(probe).toHaveBeenCalledTimes(2)
    })
  })

  /**
   * Codex has no console tier and never will from here: it records no pid for a
   * thread, so no window can be located, TUI or not. Its one way in is the
   * message queue (#97), and that is answered strictly from the SQLite registry
   * row — the source tag and the build that opened the thread. This provider is
   * built without a registry, so every session here is rollout-only and must
   * report "no channel": nothing on disk proves either condition, and a channel
   * offered on an unproven session is the ✓ that lies. The queue's own matrix
   * is pinned in codexProviderRegistry.test.ts, where a registry exists.
   */
  describe('textDelivery', () => {
    it('has no channel for a busy rollout-only thread the registry never recorded', async () => {
      const provider = makeProvider()
      await provider.scan()
      expect(provider.textDelivery(`codex:${BUSY_SESSION_ID}`)).toBeNull()
    })

    it('has no channel for an idle rollout-only thread the registry never recorded', async () => {
      const provider = makeProvider()
      await provider.scan()
      expect(provider.textDelivery(`codex:${SESSION_ID}`)).toBeNull()
    })

    it('has no channel for an unknown dwarf', () => {
      expect(makeProvider().textDelivery('codex:nobody')).toBeNull()
    })
  })

  /**
   * Issue #166: the phantom project. A Codex Desktop session that was never
   * bound to a real workspace folder writes its OWN artifact-storage path
   * (`.../Documents/Codex/<date>/<slug>`) as session_meta.cwd — verified
   * live on the maintainer's machine, 2026-09-03. Every rollout in this file
   * lives under the SAME `.codex\sessions` root regardless of cwd (see
   * `beforeEach` above), which is why the passing cases below matter: the
   * storage location a rollout is FOUND under never decides its project —
   * only its cwd field does, and only once that field is checked against
   * Codex's own artifact-storage shape.
   */
  describe('issue #166 — the storage path is never a project', () => {
    function withCwd(rolloutText: string, cwd: string): string {
      const lines = rolloutText.split('\n').filter(Boolean)
      const sessionMeta: { payload: Record<string, unknown> } = JSON.parse(lines[0]!)
      sessionMeta.payload.cwd = cwd
      lines[0] = JSON.stringify(sessionMeta)
      return lines.join('\n') + '\n'
    }

    const PHANTOM_SESSION_ID = '01a048b5-0000-0000-0000-000000000166'
    const PHANTOM_CWD = 'C:\\Users\\j\\Documents\\Codex\\2026-09-03\\este-proyecto-usa-electron'

    it("drops a session whose cwd IS Codex's own artifact-storage path, rather than laundering it as a project", async () => {
      fake.addFile(
        `${ROOT}\\2026\\08\\29\\rollout-2026-08-29T11-05-00-${PHANTOM_SESSION_ID}.jsonl`,
        withCwd(rollout.replaceAll(SESSION_ID, PHANTOM_SESSION_ID), PHANTOM_CWD),
        NOW - 30_000
      )
      const snapshots = await makeProvider().scan()
      expect(snapshots.find((s) => s.sessionId === PHANTOM_SESSION_ID)).toBeUndefined()
      // The real sibling sessions from beforeEach are unaffected.
      expect(snapshots.map((s) => s.sessionId).sort()).toEqual([BUSY_SESSION_ID, SESSION_ID])
    })

    it('still attributes a rollout stored under the Codex root to its real cwd (the storage location itself is never the signal)', async () => {
      // This is the existing default-fixture behaviour, pinned explicitly for
      // #166: the rollout physically lives under `${ROOT}` (.codex\sessions)
      // exactly like the phantom-cwd case above, yet its cwd is a real
      // project path and it must attribute there, not to its storage folder.
      const snapshots = await makeProvider().scan()
      const idle = snapshots.find((s) => s.sessionId === SESSION_ID)!
      expect(idle.cwd).toBe('C:\\Users\\j\\Desktop\\Sample-Project')
    })
  })

  /**
   * Issue #202 — the flicker. Two rules made a Codex dwarf unstable where
   * Claude's was steady, and both are gone:
   *
   * 1. A main dwarf existed only while a turn was open (`dwarfs: busy ? … : []`),
   *    so task_complete DELETED it and the next prompt built a new one — which
   *    the map's hash slot over the changing set of unplaced mines then put
   *    somewhere else (`renderer/src/lib/placement.ts`). The reported symptom
   *    was a foreman popping up at a random site and vanishing again.
   * 2. Rank was re-derived from the busy headcount on every scan: every main
   *    dwarf was born 'worker' and promoted only while a child was busy in the
   *    SAME scan, so a foreman reverted to worker the moment its child's turn
   *    closed. Claude retired exactly this rule — "the main session is the
   *    orchestrator: it is the foreman whether or not it currently has agents
   *    out" (`claudeProvider.ts`).
   *
   * What replaced them: the dwarf lives as long as the session the liveness
   * window still reports, an observed child edge makes its parent a foreman for
   * the rest of that session, and STATUS is the only thing that moves between
   * turns.
   */
  describe('a main dwarf that outlives its own turns (#202)', () => {
    const STEADY_ID = '01a048b5-steady-7312-ab78-000000000000'
    const KID_ID = '01a048b5-steadykid-ab78-000000000000'
    const STEADY_PATH = `${ROOT}\\2026\\08\\29\\rollout-2026-08-29T11-40-00-${STEADY_ID}.jsonl`
    const KID_PATH = `${ROOT}\\2026\\08\\29\\rollout-2026-08-29T11-41-00-${KID_ID}.jsonl`
    /** The fixture's own final line: the task_complete that closes its turn. */
    const TASK_COMPLETE = rolloutLines[rolloutLines.length - 1]!
    /** A second, unmatched task_started — the next prompt reopening the turn. */
    const REOPENED = JSON.stringify({
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'steady-second-turn' }
    })

    it('keeps one dwarf with one id and one role as its turn closes and reopens', async () => {
      const provider = makeProvider()
      const openTurn = busyLines().replaceAll(BUSY_SESSION_ID, STEADY_ID)
      fake.addFile(STEADY_PATH, openTurn, NOW - 10_000)
      fake.addFile(
        KID_PATH,
        withThreadSpawn(
          busyLines().replaceAll(BUSY_SESSION_ID, KID_ID),
          STEADY_ID,
          'Focused worker'
        ),
        NOW - 9_000
      )

      const working = (await provider.scan()).find((s) => s.sessionId === STEADY_ID)!

      // The child's turn ends and its rollout leaves the scan entirely. Under
      // the deleted promotion rule the parent's rank was recomputed here from
      // the children busy in THIS scan, and reverted to 'worker'.
      fake.removeFile(KID_PATH)
      // The parent's turn closes. The scan that OBSERVES the completion still
      // reads busy, because the rollout grew since the previous scan and growth
      // is the one liveness signal a frozen mtime cannot contradict (issue #1).
      // The closed turn is visible on the scan after it, with no growth left to
      // contradict it — which is why the three turn states take four scans.
      fake.addFile(STEADY_PATH, `${openTurn}${TASK_COMPLETE}\n`, NOW - 8_000)
      await provider.scan()
      const waiting = (await provider.scan()).find((s) => s.sessionId === STEADY_ID)!

      fake.addFile(STEADY_PATH, `${openTurn}${TASK_COMPLETE}\n${REOPENED}\n`, NOW - 7_000)
      const workingAgain = (await provider.scan()).find((s) => s.sessionId === STEADY_ID)!

      for (const snapshot of [working, waiting, workingAgain]) {
        expect(snapshot.dwarfs.map((dwarf) => dwarf.id)).toEqual([`codex:${STEADY_ID}`])
        expect(snapshot.dwarfs[0]!.role).toBe('foreman')
      }
      expect([working, waiting, workingAgain].map((s) => s.dwarfs[0]!.status)).toEqual([
        'working',
        'waiting',
        'working'
      ])
    })

    /**
     * The other half of the relaxed filter, and the reason it is a relaxation
     * rather than a deletion: a dwarf now belongs to every session the scan
     * reports, so the guard against resurrecting the whole scanDays window of
     * finished sessions has to be the liveness gate itself. The rollout below
     * is inside the day-directory window, has no registry row, and never
     * spoke — and it is the STALENESS that keeps it off the board, before any
     * snapshot exists to carry a dwarf.
     */
    it('leaves an aged-out rollout the registry never recorded off the board, dwarf and all', async () => {
      const HISTORY_ID = '01a048b5-history-7312-ab78-000000000000'
      const meta: { payload: Record<string, unknown> } = JSON.parse(rolloutLines[0]!)
      meta.payload.session_id = HISTORY_ID
      meta.payload.id = HISTORY_ID
      fake.addFile(
        `${ROOT}\\2026\\08\\25\\rollout-2026-08-25T09-00-00-${HISTORY_ID}.jsonl`,
        JSON.stringify(meta) + '\n',
        NOW - 4 * 24 * 60 * 60 * 1_000
      )

      const snapshots = await makeProvider().scan()
      expect(snapshots.map((s) => s.sessionId)).not.toContain(HISTORY_ID)
      expect(snapshots.flatMap((s) => s.dwarfs.map((dwarf) => dwarf.id))).not.toContain(
        `codex:${HISTORY_ID}`
      )
    })
  })

  /**
   * Issue #219 — a finished agent goes home; an idle root does not.
   *
   * #202 froze a Codex dwarf's existence to its SESSION rather than its turn,
   * which is right for a root: a human between prompts is idle, and may speak
   * again. It left the liveness gate alone, so a spawned agent that had closed
   * its turn aged out on the same window — `livenessWindowS + idleRetentionS`,
   * 3900s on the shipped defaults, granted for as long as ANY codex process is
   * alive anywhere because the probe is global. Measured on a real round of
   * agents: three finished workers resting for about 65 minutes.
   *
   * Finished and idle are different facts, and the distinction is NOT the busy
   * headcount — that is the rule #202 retired and #209 deleted, and nothing
   * below re-derives it. It is two records the thread carries about itself:
   *
   * 1. a spawn edge, from its own `session_meta.source.subagent.thread_spawn`
   *    or the registry's `thread_spawn_edges` — a root has neither, so a root
   *    can never take this path, and
   * 2. `task_complete` in its own rollout, with no turn reopened after it
   *    (`completedTurn`, parse.ts). A turn it OPENED and CLOSED. `busy: false`
   *    alone is not that record: it is also a thread whose first task_started
   *    is not on disk yet, which is why the guard below exists.
   */
  describe('a spawned agent that has finished its turn (#219)', () => {
    const ROOT_ID = '01a048b5-root219-7312-ab78-000000000000'
    const AGENT_ID = '01a048b5-agent219-ab78-000000000000'
    const ROOT_PATH = `${ROOT}\\2026\\08\\29\\rollout-2026-08-29T11-50-00-${ROOT_ID}.jsonl`
    const AGENT_PATH = `${ROOT}\\2026\\08\\29\\rollout-2026-08-29T11-51-00-${AGENT_ID}.jsonl`
    /** The fixture's own final line: the task_complete that closes its turn. */
    const TASK_COMPLETE = rolloutLines[rolloutLines.length - 1]!
    /** An unmatched task_started — a turn opening on a thread thought finished. */
    const REOPENED = JSON.stringify({
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'agent-second-turn' }
    })

    /** A root whose own last turn completed: idle, and #202 says it stays. */
    function idleRoot(): string {
      return rollout.replaceAll(SESSION_ID, ROOT_ID)
    }

    /** The same rollout, re-keyed and carrying the spawn edge back to the root. */
    function spawnedAgent(body: string): string {
      return withThreadSpawn(body.replaceAll(SESSION_ID, AGENT_ID), ROOT_ID, 'Report writer')
    }

    function dwarfIds(snapshots: { dwarfs: { id: string }[] }[]): string[] {
      return snapshots.flatMap((snapshot) => snapshot.dwarfs.map((dwarf) => dwarf.id))
    }

    it('takes it off the board on the scan after its turn completes, while its idle root stays', async () => {
      const provider = makeProvider()
      fake.addFile(ROOT_PATH, idleRoot(), NOW - 60_000)
      const openTurn = spawnedAgent(busyRollout)
      fake.addFile(AGENT_PATH, openTurn, NOW - 10_000)

      const working = await provider.scan()
      expect(working.find((s) => s.sessionId === AGENT_ID)!.dwarfs[0]).toMatchObject({
        id: `codex:${AGENT_ID}`,
        role: 'worker',
        status: 'working'
      })

      // The scan that OBSERVES the completion still reads busy, because the
      // rollout grew since the previous scan and growth is the one liveness
      // signal a frozen mtime cannot contradict (issue #1). Retiring here
      // would take the agent off the board while it was still filing its
      // report, so the completed turn only counts once growth has stopped.
      fake.addFile(AGENT_PATH, `${openTurn}${TASK_COMPLETE}\n`, NOW - 9_000)
      const observing = await provider.scan()
      expect(observing.map((s) => s.sessionId)).toContain(AGENT_ID)
      expect(observing.find((s) => s.sessionId === AGENT_ID)!.dwarfs[0]).toMatchObject({
        status: 'working'
      })

      const after = await provider.scan()
      expect(after.map((s) => s.sessionId)).not.toContain(AGENT_ID)
      expect(dwarfIds(after)).not.toContain(`codex:${AGENT_ID}`)
      // The whole point of the split: the root is idle in this very scan, with
      // a completed turn of its own, and it is untouched (#202, #47, #68).
      const root = after.find((s) => s.sessionId === ROOT_ID)!
      expect(root.status).toBe('idle')
      expect(root.dwarfs[0]).toMatchObject({
        id: `codex:${ROOT_ID}`,
        role: 'foreman',
        status: 'waiting'
      })
    })

    /**
     * #209's rank rule, guarded against the order of this fix. The edge that
     * makes a root a foreman is read off the CHILD, so a retirement applied
     * before `linkSubagents` would silently demote a root whose only agent was
     * already finished when the panel started — the identity swap #202 fixed,
     * reintroduced through the back door.
     */
    it('still ranks its root a foreman when the agent is already finished on the first scan', async () => {
      fake.addFile(ROOT_PATH, idleRoot(), NOW - 60_000)
      fake.addFile(AGENT_PATH, spawnedAgent(rollout), NOW - 9_000)

      const snapshots = await makeProvider().scan()
      expect(snapshots.map((s) => s.sessionId)).not.toContain(AGENT_ID)
      expect(snapshots.find((s) => s.sessionId === ROOT_ID)!.dwarfs[0]!.role).toBe('foreman')
    })

    /**
     * The guard on reading the record rather than its absence. A thread whose
     * session_meta is on disk but whose first task_started is not has
     * `busy: false` exactly like a finished one — retiring on `!busy` would
     * send a worker home before it ever picked up a pick, and bring it back on
     * the next tick. Flicker, which is what #202 was.
     */
    it('keeps a just-spawned agent whose turn has not started yet', async () => {
      fake.addFile(ROOT_PATH, idleRoot(), NOW - 60_000)
      fake.addFile(AGENT_PATH, spawnedAgent(rolloutLines[0]! + '\n'), NOW - 1_000)

      const snapshots = await makeProvider().scan()
      expect(snapshots.map((s) => s.sessionId)).toContain(AGENT_ID)
      expect(snapshots.find((s) => s.sessionId === AGENT_ID)!.dwarfs[0]).toMatchObject({
        id: `codex:${AGENT_ID}`,
        status: 'waiting'
      })
    })

    /**
     * Retirement is a withdrawal, not a deletion, and that is what keeps this
     * fix from being the thing #202 forbade. Nothing in the provider is
     * pruned when an agent goes home: if its thread ever writes another turn,
     * the growth that proves it brings back the SAME dwarf id under the same
     * remembered rank.
     */
    it('brings it back under the same id if its thread ever opens another turn', async () => {
      const provider = makeProvider()
      fake.addFile(ROOT_PATH, idleRoot(), NOW - 60_000)
      const finished = spawnedAgent(rollout)
      fake.addFile(AGENT_PATH, finished, NOW - 9_000)
      expect((await provider.scan()).map((s) => s.sessionId)).not.toContain(AGENT_ID)

      fake.addFile(AGENT_PATH, `${finished}${REOPENED}\n`, NOW - 8_000)
      const reopened = (await provider.scan()).find((s) => s.sessionId === AGENT_ID)!
      expect(reopened.dwarfs[0]).toMatchObject({
        id: `codex:${AGENT_ID}`,
        role: 'worker',
        status: 'working',
        parentId: `codex:${ROOT_ID}`
      })
    })
  })

  /**
   * Issue #264. The liveness gate is the one place a Codex session stops being
   * live, and it used to reject in complete silence: this provider carried no
   * log statement at all, so "my session is not on the board" could only be
   * answered by reading the source and guessing which branch had fired.
   */
  describe('reporting why a candidate was refused (#264)', () => {
    const REFUSED_ID = '01a048b5-2640-7312-ab78-264264264264'
    const refusedPath = `${ROOT}\\2026\\08\\29\\rollout-2026-08-29T01-00-00-${REFUSED_ID}.jsonl`

    function refusedRollout(): string {
      return rollout.replaceAll(SESSION_ID, REFUSED_ID)
    }

    /** Only the lines about the candidate under test; the fixtures produce their own. */
    async function skipLines(overrides: Partial<CodexProviderOptions> = {}): Promise<string[]> {
      const lines: string[] = []
      await makeProvider({ debug: true, log: (line) => lines.push(line), ...overrides }).scan()
      return lines.filter((line) => line.includes(REFUSED_ID))
    }

    it('names the retention floor for a rollout no signal can keep alive', async () => {
      fake.addFile(refusedPath, refusedRollout(), NOW - 10 * 24 * 3600_000)
      const [line] = await skipLines()
      expect(line).toContain('retention-floor')
      // The age is the number that makes the verdict checkable against the
      // configured window instead of merely reported.
      expect(line).toContain('age 864000s')
      expect(line).toContain(refusedPath)
    })

    it('names the process probe for a quiet rollout with no codex running', async () => {
      // Between freshAfter and retainAfter: the one band where the verdict is
      // the probe's rather than the clock's.
      fake.addFile(refusedPath, refusedRollout(), NOW - 900_000)
      const [line] = await skipLines({
        idleRetentionS: 600,
        isCodexProcessRunning: async () => false
      })
      expect(line).toContain('no-process')
    })

    it('names an unreadable rollout the registry never recorded', async () => {
      // A rollout-shaped file with no session_meta: nothing states the session
      // id or its cwd, and no registry row makes up for it.
      fake.addFile(refusedPath, '{"type":"response_item"}\n', NOW - 30_000)
      expect((await skipLines())[0]).toContain('unreadable-rollout')
    })

    it("names Codex's own artifact-storage path for a session that has no project", async () => {
      // The #166 drop, which is a deliberate refusal rather than a fault — and
      // was the hardest of all to tell apart from a bug without a line saying so.
      const lines = new Array<string>()
      const meta: { payload: Record<string, unknown> } = JSON.parse(rolloutLines[0]!)
      meta.payload.cwd = 'C:\\Users\\j\\Documents\\Codex\\2026-09-03\\a-slug'
      meta.payload.session_id = REFUSED_ID
      meta.payload.id = REFUSED_ID
      fake.addFile(
        refusedPath,
        [JSON.stringify(meta), ...rolloutLines.slice(1)].join('\n') + '\n',
        NOW - 30_000
      )
      await makeProvider({ debug: true, log: (line) => lines.push(line) }).scan()
      expect(lines.find((line) => line.includes(REFUSED_ID))).toContain('artifact-cwd')
    })

    it('says nothing at all while the flag is off', async () => {
      fake.addFile(refusedPath, refusedRollout(), NOW - 10 * 24 * 3600_000)
      const lines: string[] = []
      // Not merely quiet about this candidate: quiet about every one of them,
      // which is what the shipped app must be.
      await makeProvider({ log: (line) => lines.push(line) }).scan()
      expect(lines).toEqual([])
    })

    it('keeps refusing nothing it used to accept', async () => {
      // The diagnostic is a report, never a decision: with it on, the same two
      // fixture sessions are still the ones on the board.
      fake.addFile(refusedPath, refusedRollout(), NOW - 10 * 24 * 3600_000)
      const snapshots = await makeProvider({ debug: true, log: () => undefined }).scan()
      expect(snapshots.map((s) => s.sessionId).sort()).toEqual([BUSY_SESSION_ID, SESSION_ID])
    })
  })
})

describe('codexDebugEnabled', () => {
  it('stays off when the flag is absent', () => {
    expect(codexDebugEnabled({})).toBe(false)
  })

  it('stays off for the explicit off values', () => {
    expect(codexDebugEnabled({ CODEX_DEBUG: '0' })).toBe(false)
    expect(codexDebugEnabled({ CODEX_DEBUG: 'false' })).toBe(false)
    expect(codexDebugEnabled({ CODEX_DEBUG: '' })).toBe(false)
  })

  it('turns on for 1 and true, whatever the casing', () => {
    expect(codexDebugEnabled({ CODEX_DEBUG: '1' })).toBe(true)
    expect(codexDebugEnabled({ CODEX_DEBUG: 'true' })).toBe(true)
    expect(codexDebugEnabled({ CODEX_DEBUG: 'TRUE' })).toBe(true)
  })
})

describe('formatCodexSkip', () => {
  it('states the reason, the age, whether the registry knew it, and the path', () => {
    expect(
      formatCodexSkip({
        reason: 'retention-floor',
        path: 'C:\\r\\rollout-a.jsonl',
        registered: true,
        activityAgeS: 4321
      })
    ).toBe('[codex] skip retention-floor age 4321s registry row C:\\r\\rollout-a.jsonl')
  })

  it('says the registry never recorded the rollout, rather than leaving it out', () => {
    // The single most useful fact when a session is missing: whether Codex
    // itself has a row for it, or only a file exists.
    expect(
      formatCodexSkip({ reason: 'unreadable-rollout', path: 'C:\\r\\b.jsonl', registered: false })
    ).toBe('[codex] skip unreadable-rollout registry none C:\\r\\b.jsonl')
  })
})

/*
 * The launch receipt's read (#191). A detached Codex launch leaves no held
 * conversation, so the only evidence that ties a dwarf on the board to the Add
 * Panel's own launch is the prompt the rollout recorded as its first human
 * turn — and that sits at the head of the file, where no tail read reaches.
 */
describe('CodexProvider.firstPrompt', () => {
  let fake: FakeFs

  const PATH = `${ROOT}\\2026\\08\\29\\rollout-2026-08-29T11-00-00-${SESSION_ID}.jsonl`

  function makeProvider(): CodexProvider {
    return new CodexProvider({
      fs: fake,
      sessionsRoot: ROOT,
      livenessWindowS: WINDOW_S,
      scanDays: 7,
      idleRetentionS: 0,
      now: () => NOW
    })
  }

  beforeEach(() => {
    fake = new FakeFs()
    fake.addFile(PATH, rollout, NOW - 60_000)
  })

  it('answers the prompt the rollout opened with', async () => {
    const provider = makeProvider()
    await provider.scan()

    await expect(provider.firstPrompt(`codex:${SESSION_ID}`)).resolves.toBe(
      'Placeholder plain message.'
    )
  })

  it('knows nothing about a dwarf no scan has seen', async () => {
    await expect(makeProvider().firstPrompt('codex:nobody')).resolves.toBeUndefined()
  })

  /*
   * The one thing this read must NOT do that feed() does. feed() redacts on
   * the way to the renderer, because a pasted key reaches a screenshot from
   * there. This string never leaves main — it is compared against the prompt
   * main itself sent and dropped — so redacting it would only guarantee the
   * comparison fails for anyone whose prompt looks like key material.
   */
  it('answers the raw prompt, because nothing here is ever displayed', async () => {
    const secret = 'deploy with sk-abcdefghijklmnopqrstuvwxyz012345 now'
    fake.addFile(PATH, rollout.replace('Placeholder plain message.', secret), NOW - 60_000)
    const provider = makeProvider()
    await provider.scan()

    await expect(provider.firstPrompt(`codex:${SESSION_ID}`)).resolves.toBe(secret)
    // The panel's own read of the same words still redacts them.
    const shown = await provider.feed(`codex:${SESSION_ID}`, 12)
    expect(shown?.[0]?.text).toContain('[redacted]')
  })
})

/**
 * The one question Codex records, reaching the dwarf (#265).
 *
 * The fixture is the measured shape (docs/codex-v2-format.md §9(c)): a
 * `request_user_input` function_call whose `arguments` are a JSON-encoded
 * string, and no `function_call_output` for its `call_id`.
 */
describe('CodexProvider pendingQuestion', () => {
  const ASK_SESSION_ID = '01a05f7c-1d2e-73a4-9c05-2f81d6b44ae0'
  const ASK_PATH = `${ROOT}\\2026\\08\\29\\rollout-2026-08-29T11-30-00-${ASK_SESSION_ID}.jsonl`
  const asking = readFileSync(join(FIXTURES, 'rollout-pending-question.jsonl'), 'utf8')

  /** The same rollout once the person has chosen: the call has its output. */
  function answered(): string {
    return (
      asking +
      JSON.stringify({
        timestamp: '2026-08-24T12:39:40.997Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call_9c052f81d6b44',
          output: 'Source only'
        }
      }) +
      '\n'
    )
  }

  let fake: FakeFs

  function scan(text: string): Promise<ProviderSnapshot[]> {
    fake = new FakeFs()
    fake.addFile(ASK_PATH, text, NOW - 60_000)
    return new CodexProvider({
      fs: fake,
      sessionsRoot: ROOT,
      livenessWindowS: WINDOW_S,
      scanDays: 7,
      idleRetentionS: 0,
      now: () => NOW
    }).scan()
  }

  async function dwarfFor(text: string) {
    const snapshots = await scan(text)
    return snapshots.find((s) => s.sessionId === ASK_SESSION_ID)?.dwarfs[0]
  }

  it('carries the unanswered question and the answers the model offered', async () => {
    expect((await dwarfFor(asking))?.pendingQuestion).toEqual({
      toolUseId: 'call_9c052f81d6b44',
      header: 'Scope',
      question: "Should the rename cover the sample module's tests as well, or only its source?",
      multiSelect: false,
      askedAt: '2026-08-24T12:37:01.545Z',
      options: [
        {
          label: 'Source and tests',
          description: 'Rename every occurrence, including the fixtures the tests read.'
        },
        {
          label: 'Source only',
          description: 'Leave the tests untouched so their failures stay readable.'
        }
      ]
    })
  })

  it('drops the question once a function_call_output names the same call_id', async () => {
    expect((await dwarfFor(answered()))?.pendingQuestion).toBeUndefined()
  })

  /**
   * The deliberate half, and the one an agent is most likely to "fix" (#265).
   *
   * A question may REFINE waitingReason and may never ASSERT it — see
   * DwarfQuestion in contracts.ts, whose own wording covers exactly this case:
   * "an ask inside a running turn is the model still working rather than a
   * human being waited on". Claude may name the reason because its REGISTRY
   * watched the session stop; Codex has no such record and this build writes
   * none, so the panel repeats the question and claims nothing about blockage.
   * Setting 'user-input' here would also silently buy the dwarf the eviction
   * exemption WAITING_ON_HUMAN_REASON promises, off evidence that never proved
   * the session stopped.
   */
  it('claims no waiting reason, because no Codex record proves the session stopped', async () => {
    const dwarf = await dwarfFor(asking)
    expect(dwarf?.pendingQuestion).toBeDefined()
    expect(dwarf?.waitingReason).toBeUndefined()
    // The turn really is open, and that stays the only thing said about it.
    expect(dwarf?.status).toBe('working')
  })

  it('redacts key material out of the question before it leaves the provider', async () => {
    const leaky = asking.replace('Source only', 'Use sk-abcdefghijklmnopqrstuvwxyz012345 instead')
    const question = (await dwarfFor(leaky))?.pendingQuestion
    expect(JSON.stringify(question)).toContain('[redacted]')
    expect(JSON.stringify(question)).not.toContain('sk-abcdefghijklmnopqrstuvwxyz012345')
  })
})
