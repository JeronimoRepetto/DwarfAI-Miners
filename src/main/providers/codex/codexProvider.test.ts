import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeFs } from '../../adapters/fakeFs'
import { CODEX_PROBE_SCRIPT } from '../../adapters/processProbe'
import { CodexProvider, type CodexProviderOptions } from './codexProvider'

const FIXTURES = join(import.meta.dirname, '..', '__fixtures__', 'codex')
const rollout = readFileSync(join(FIXTURES, 'rollout.jsonl'), 'utf8')
const rolloutLines = rollout.split('\n').filter(Boolean)
/** Same rollout with the final task_complete missing: the turn is still open. */
const busyRollout = rolloutLines.slice(0, rolloutLines.length - 1).join('\n') + '\n'

const ROOT = 'C:\\Users\\jeron\\.codex\\sessions'
const SESSION_ID = '01a048b5-5f35-7312-ab78-38db464920de'
const BUSY_SESSION_ID = '01a048b5-0000-7312-ab78-000000000000'

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

  it('maps a completed last turn to an idle snapshot with no dwarfs', async () => {
    const snapshots = await makeProvider().scan()
    const idle = snapshots.find((s) => s.sessionId === SESSION_ID)!
    expect(idle.status).toBe('idle')
    expect(idle.dwarfs).toEqual([])
    expect(idle.cwd).toBe('C:\\Users\\jeron\\Desktop\\Sample-Project')
    expect(idle.updatedAt).toBe(NOW - 60_000)
  })

  it('maps an open turn to a busy snapshot with a single worker dwarf', async () => {
    const snapshots = await makeProvider().scan()
    const busy = snapshots.find((s) => s.sessionId === BUSY_SESSION_ID)!
    expect(busy.status).toBe('busy')
    expect(busy.cwd).toBe('C:\\Users\\jeron\\Desktop\\Busy-Project')
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

  it('uses explicit Codex thread_spawn data to name a worker and promote its observed parent', async () => {
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
  })
})
