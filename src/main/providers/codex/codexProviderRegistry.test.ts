import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeFs } from '../../adapters/fakeFs'
import { MemorySqlite } from '../../adapters/memorySqlite'
import { CodexProvider, type CodexProviderOptions } from './codexProvider'
import {
  CODEX_LOGS_SCHEMA,
  CODEX_STATE_SCHEMA,
  logInsert,
  spawnEdgeInsert,
  subagentSource,
  threadInsert
} from './stateSeed'

/**
 * Issue #1: Windows freezes a growing rollout's mtime.
 *
 * Verified on this machine on 2026-08-29: thread 01a04d79-… had a 3,665,221
 * byte rollout whose newest content line was 952s old while the file's mtime
 * read 18,936s (5.3h) old, because Codex holds the file open for the whole
 * session. mtime-based liveness therefore discarded a genuinely live session.
 * Discovery and liveness key on the SQLite registry, the logs heartbeat and
 * file-size growth instead — never on mtime alone.
 */

const FIXTURES = join(import.meta.dirname, '..', '__fixtures__', 'codex')
const rolloutFixture = readFileSync(join(FIXTURES, 'rollout.jsonl'), 'utf8')
const rolloutLines = rolloutFixture.split('\n').filter(Boolean)
/** Same rollout with the final task_complete missing: the turn is still open. */
const busyFixture = rolloutLines.slice(0, rolloutLines.length - 1).join('\n') + '\n'

const FIXTURE_ID = '01a048b5-5f35-7312-ab78-38db464920de'
const ROOT = 'C:\\Users\\jeron\\.codex\\sessions'
const STATE_DB = 'C:\\Users\\jeron\\.codex\\state_5.sqlite'
const LOGS_DB = 'C:\\Users\\jeron\\.codex\\logs_2.sqlite'

const NOW = new Date(2026, 7, 29, 12, 0, 0).getTime()
const WINDOW_S = 600
const RETENTION_S = 3600

const LIVE_ID = '01a04d79-5c87-7a31-9b1a-4aacc350d6fd'
const LIVE_ROLLOUT = ROOT + '\\2026\\08\\29\\rollout-2026-08-29T09-00-00-' + LIVE_ID + '.jsonl'
/** mtime frozen 5.3h ago, exactly as observed — far past liveness + retention. */
const FROZEN_MTIME = NOW - 18_936 * 1_000

/** The fixture rollout re-keyed to a given session id. */
function idleRollout(sessionId: string): string {
  return rolloutFixture.replaceAll(FIXTURE_ID, sessionId)
}

function busyRollout(sessionId: string): string {
  return busyFixture.replaceAll(FIXTURE_ID, sessionId)
}

function rolloutPathFor(sessionId: string): string {
  return ROOT + '\\2026\\08\\29\\rollout-2026-08-29T09-00-00-' + sessionId + '.jsonl'
}

describe('CodexProvider with the Codex SQLite registry', () => {
  let fake: FakeFs
  let sqlite: MemorySqlite

  function makeProvider(overrides: Partial<CodexProviderOptions> = {}): CodexProvider {
    return new CodexProvider({
      fs: fake,
      sessionsRoot: ROOT,
      livenessWindowS: WINDOW_S,
      scanDays: 7,
      idleRetentionS: RETENTION_S,
      heartbeatWindowS: WINDOW_S,
      sqlite,
      stateDbPath: STATE_DB,
      logsDbPath: LOGS_DB,
      isCodexProcessRunning: async () => false,
      now: () => NOW,
      ...overrides
    })
  }

  beforeEach(() => {
    fake = new FakeFs()
    sqlite = new MemorySqlite()
    sqlite.define(STATE_DB, CODEX_STATE_SCHEMA)
    sqlite.define(LOGS_DB, CODEX_LOGS_SCHEMA)
  })

  /** The live-but-mtime-frozen session, present on disk and in the registry. */
  function seedLiveThread(overrides: Partial<Parameters<typeof threadInsert>[0]> = {}): void {
    fake.addFile(LIVE_ROLLOUT, idleRollout(LIVE_ID), FROZEN_MTIME)
    sqlite.exec(
      STATE_DB,
      threadInsert({
        id: LIVE_ID,
        cwd: '\\\\?\\C:\\Users\\jeron\\Desktop\\AI-Tools\\agent-name',
        rolloutPath: LIVE_ROLLOUT,
        model: 'gpt-5.6-luna',
        effort: 'medium',
        tokensUsed: 19343971,
        updatedAtMs: NOW - 30_000,
        ...overrides
      })
    )
  }

  it('detects a session whose rollout mtime is frozen but whose registry row is fresh', async () => {
    seedLiveThread()
    expect((await makeProvider().scan()).map((s) => s.sessionId)).toEqual([LIVE_ID])
  })

  it('pins the bug: the same session is invisible when only the frozen mtime is available', async () => {
    fake.addFile(LIVE_ROLLOUT, idleRollout(LIVE_ID), FROZEN_MTIME)
    const snapshots = await makeProvider({
      sqlite: undefined,
      stateDbPath: undefined,
      logsDbPath: undefined
    }).scan()
    expect(snapshots).toEqual([])
  })

  it('takes cwd from the registry row, without the extended-length prefix', async () => {
    seedLiveThread()
    const [snapshot] = await makeProvider().scan()
    // Leaving the \\?\ prefix on would split one project into two mines.
    expect(snapshot!.cwd).toBe('C:\\Users\\jeron\\Desktop\\AI-Tools\\agent-name')
  })

  it('exposes the registry model, effort and token count on the dwarf', async () => {
    fake.addFile(LIVE_ROLLOUT, busyRollout(LIVE_ID), FROZEN_MTIME)
    sqlite.exec(
      STATE_DB,
      threadInsert({
        id: LIVE_ID,
        cwd: '\\\\?\\C:\\proj',
        rolloutPath: LIVE_ROLLOUT,
        model: 'gpt-5.6-luna',
        effort: 'medium',
        tokensUsed: 19343971,
        updatedAtMs: NOW - 30_000
      })
    )
    const [snapshot] = await makeProvider().scan()
    expect(snapshot!.dwarfs[0]).toMatchObject({
      model: 'gpt-5.6-luna',
      effort: 'medium',
      tokensUsed: 19343971,
      status: 'working'
    })
  })

  it('reports the freshest registry activity as updatedAt instead of the frozen mtime', async () => {
    seedLiveThread()
    const [snapshot] = await makeProvider().scan()
    expect(snapshot!.updatedAt).toBe(NOW - 30_000)
  })

  it('keeps a session live on a fresh logs heartbeat when the registry row is past the liveness window', async () => {
    fake.addFile(LIVE_ROLLOUT, idleRollout(LIVE_ID), FROZEN_MTIME)
    sqlite.exec(
      STATE_DB,
      threadInsert({
        id: LIVE_ID,
        cwd: 'C:\\proj',
        rolloutPath: LIVE_ROLLOUT,
        // Past livenessWindowS (600s) but inside liveness + retention.
        updatedAtMs: NOW - 2_000 * 1_000
      })
    )
    sqlite.exec(LOGS_DB, logInsert(LIVE_ID, (NOW - 10_000) / 1_000))

    // No process probe needed: the heartbeat itself proves the session is live.
    const probe = vi.fn(async () => false)
    const snapshots = await makeProvider({ isCodexProcessRunning: probe }).scan()
    expect(snapshots.map((s) => s.sessionId)).toEqual([LIVE_ID])
    expect(probe).not.toHaveBeenCalled()
    // A heartbeat proves liveness but must never promote to busy: only an open
    // turn or observed rollout growth may do that.
    expect(snapshots[0]!.status).toBe('idle')
    expect(snapshots[0]!.dwarfs).toEqual([])
  })

  it('ignores a heartbeat older than the heartbeat window', async () => {
    fake.addFile(LIVE_ROLLOUT, idleRollout(LIVE_ID), FROZEN_MTIME)
    sqlite.exec(
      STATE_DB,
      threadInsert({
        id: LIVE_ID,
        cwd: 'C:\\proj',
        rolloutPath: LIVE_ROLLOUT,
        updatedAtMs: NOW - 2_000 * 1_000
      })
    )
    sqlite.exec(LOGS_DB, logInsert(LIVE_ID, (NOW - 5_000 * 1_000) / 1_000))
    expect(await makeProvider().scan()).toEqual([])
  })

  it('keeps a registry session past the liveness window visible while a codex process runs', async () => {
    fake.addFile(LIVE_ROLLOUT, idleRollout(LIVE_ID), FROZEN_MTIME)
    sqlite.exec(
      STATE_DB,
      threadInsert({
        id: LIVE_ID,
        cwd: 'C:\\proj',
        rolloutPath: LIVE_ROLLOUT,
        updatedAtMs: NOW - 2_000 * 1_000
      })
    )
    const snapshots = await makeProvider({ isCodexProcessRunning: async () => true }).scan()
    expect(snapshots.map((s) => s.sessionId)).toEqual([LIVE_ID])
  })

  it('treats a rollout that grew since the previous scan as live and busy', async () => {
    // A grown file is direct proof of writes happening now — the one signal a
    // frozen mtime cannot contradict.
    fake.addFile(LIVE_ROLLOUT, idleRollout(LIVE_ID), FROZEN_MTIME)
    sqlite.exec(
      STATE_DB,
      threadInsert({
        id: LIVE_ID,
        cwd: 'C:\\proj',
        rolloutPath: LIVE_ROLLOUT,
        updatedAtMs: NOW - 30_000
      })
    )
    const provider = makeProvider()
    expect((await provider.scan())[0]!.status).toBe('idle')

    fake.addFile(LIVE_ROLLOUT, idleRollout(LIVE_ID) + 'x'.repeat(4_096), FROZEN_MTIME)
    const second = await provider.scan()
    expect(second[0]!.status).toBe('busy')
    expect(second[0]!.dwarfs[0]).toMatchObject({ status: 'working' })
  })

  it('keeps a grown rollout live even when every timestamp is stale', async () => {
    // Registry row past retention, no heartbeat, no codex process: growth alone
    // must still hold the session on the map.
    fake.addFile(LIVE_ROLLOUT, idleRollout(LIVE_ID), FROZEN_MTIME)
    const provider = makeProvider({ sqlite: new MemorySqlite() })
    expect(await provider.scan()).toEqual([])

    fake.addFile(LIVE_ROLLOUT, idleRollout(LIVE_ID) + 'x'.repeat(4_096), FROZEN_MTIME)
    expect((await provider.scan()).map((s) => s.sessionId)).toEqual([LIVE_ID])
  })

  it('does not call a session busy from growth on the very first scan', async () => {
    seedLiveThread()
    expect((await makeProvider().scan())[0]!.status).toBe('idle')
  })

  it('links a sub-agent thread to its parent through the registry spawn graph', async () => {
    const parentId = '01a04d79-0000-7000-0000-0000000000aa'
    const childId = '01a04d7e-0000-7000-0000-0000000000bb'
    const parentRollout = rolloutPathFor(parentId)
    const childRollout = rolloutPathFor(childId)
    fake.addFile(parentRollout, busyRollout(parentId), FROZEN_MTIME)
    fake.addFile(childRollout, busyRollout(childId), FROZEN_MTIME)
    sqlite.exec(
      STATE_DB,
      threadInsert({ id: parentId, cwd: 'C:\\p', rolloutPath: parentRollout, updatedAtMs: NOW })
    )
    sqlite.exec(
      STATE_DB,
      threadInsert({
        id: childId,
        cwd: 'C:\\p',
        rolloutPath: childRollout,
        updatedAtMs: NOW,
        agentNickname: 'Bernoulli',
        source: subagentSource(parentId, 'Bernoulli')
      })
    )
    sqlite.exec(STATE_DB, spawnEdgeInsert(parentId, childId))

    const snapshots = await makeProvider().scan()
    const parent = snapshots.find((s) => s.sessionId === parentId)!
    const child = snapshots.find((s) => s.sessionId === childId)!
    expect(parent.dwarfs[0]).toMatchObject({ role: 'foreman', sessionId: parentId })
    expect(child.dwarfs[0]).toMatchObject({ role: 'worker', name: 'Bernoulli' })
  })

  it('detects a registry thread whose rollout file is not on disk', async () => {
    // The desktop app can register a thread before a readable rollout exists;
    // the registry row alone still describes the session.
    sqlite.exec(
      STATE_DB,
      threadInsert({
        id: LIVE_ID,
        cwd: '\\\\?\\C:\\proj',
        rolloutPath: ROOT + '\\2026\\08\\29\\rollout-missing-' + LIVE_ID + '.jsonl',
        model: 'gpt-5.6-terra',
        updatedAtMs: NOW - 5_000
      })
    )
    const [snapshot] = await makeProvider().scan()
    expect(snapshot).toMatchObject({ sessionId: LIVE_ID, cwd: 'C:\\proj', status: 'idle' })
  })

  it('reports a session once when the registry and the day-directory scan both find it', async () => {
    seedLiveThread()
    const snapshots = await makeProvider().scan()
    expect(snapshots.filter((s) => s.sessionId === LIVE_ID)).toHaveLength(1)
  })

  it('serves the rollout feed for a session discovered through the registry', async () => {
    fake.addFile(LIVE_ROLLOUT, busyRollout(LIVE_ID), FROZEN_MTIME)
    sqlite.exec(
      STATE_DB,
      threadInsert({
        id: LIVE_ID,
        cwd: 'C:\\proj',
        rolloutPath: LIVE_ROLLOUT,
        updatedAtMs: NOW - 30_000
      })
    )
    const provider = makeProvider()
    await provider.scan()
    expect(provider.transcriptPath('codex:' + LIVE_ID)).toBe(LIVE_ROLLOUT)
    expect((await provider.feed('codex:' + LIVE_ID, 20))!.map((m) => m.role)).toEqual([
      'user',
      'assistant'
    ])
  })

  it('keeps working when the registry databases are missing', async () => {
    fake.addFile(LIVE_ROLLOUT, idleRollout(LIVE_ID), NOW - 30_000)
    const snapshots = await makeProvider({ sqlite: new MemorySqlite() }).scan()
    expect(snapshots.map((s) => s.sessionId)).toEqual([LIVE_ID])
  })

  it('keeps working against a Codex build whose registry schema is unknown', async () => {
    const other = new MemorySqlite()
    other.define(STATE_DB, 'CREATE TABLE conversations (id TEXT)')
    other.define(LOGS_DB, 'CREATE TABLE events (id TEXT)')
    fake.addFile(LIVE_ROLLOUT, idleRollout(LIVE_ID), NOW - 30_000)
    const snapshots = await makeProvider({ sqlite: other }).scan()
    expect(snapshots.map((s) => s.sessionId)).toEqual([LIVE_ID])
  })
})
