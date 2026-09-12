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
const ROOT = 'C:\\Users\\j\\.codex\\sessions'
const STATE_DB = 'C:\\Users\\j\\.codex\\state_5.sqlite'
const LOGS_DB = 'C:\\Users\\j\\.codex\\logs_2.sqlite'

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
        cwd: '\\\\?\\C:\\Users\\j\\Desktop\\Sample-Project\\agent-name',
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
    expect(snapshot!.cwd).toBe('C:\\Users\\j\\Desktop\\Sample-Project\\agent-name')
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
      // Mirrors tokensUsed so the ore/vault economy has one field to sum
      // across providers (see Mine.tokensObserved).
      tokensObserved: 19343971,
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
    // AMENDED for #202 (was: `dwarfs` is `[]`). The clause above is the whole
    // reason this line had to change: a heartbeat PROVES the session is live,
    // and a live session that showed no dwarf was the flicker — a Codex dwarf
    // that existed only inside an open turn. The dwarf is here and resting;
    // only the busy claim is withheld.
    expect(snapshots[0]!.dwarfs).toHaveLength(1)
    expect(snapshots[0]!.dwarfs[0]).toMatchObject({ id: 'codex:' + LIVE_ID, status: 'waiting' })
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

  it("carries a sub-agent's launcher edge and its objective onto the dwarf", async () => {
    // #218. Two facts the panel had no way to state: who launched this thread
    // — the id `codex:<uuid>` never said, and slicing it named the literal
    // `codex` — and what it was asked to do, which only `agent_path` carries.
    const parentId = '01a04d79-0000-7000-0000-0000000000cc'
    const childId = '01a04d7e-0000-7000-0000-0000000000dd'
    const parentRollout = rolloutPathFor(parentId)
    const childRollout = rolloutPathFor(childId)
    fake.addFile(parentRollout, busyRollout(parentId), FROZEN_MTIME)
    fake.addFile(childRollout, busyRollout(childId), FROZEN_MTIME)
    sqlite.exec(
      STATE_DB,
      threadInsert({ id: parentId, cwd: 'C:\p', rolloutPath: parentRollout, updatedAtMs: NOW })
    )
    sqlite.exec(
      STATE_DB,
      threadInsert({
        id: childId,
        cwd: 'C:\p',
        rolloutPath: childRollout,
        updatedAtMs: NOW,
        agentNickname: 'Bernoulli',
        source: subagentSource(parentId, 'Bernoulli', '/root/audit_chain_report')
      })
    )

    const snapshots = await makeProvider().scan()
    const child = snapshots.find((s) => s.sessionId === childId)!
    expect(child.dwarfs[0]).toMatchObject({
      parentId: `codex:${parentId}`,
      description: '/root/audit_chain_report'
    })
  })

  it('leaves a root thread with no launcher edge and no objective', async () => {
    // The other half, and the one that was already right: nothing launched a
    // root, so the prompt in its rollout really was the human's (#175).
    seedLiveThread()
    const [snapshot] = await makeProvider().scan()
    expect(snapshot?.dwarfs[0]?.parentId).toBeUndefined()
    expect(snapshot?.dwarfs[0]?.description).toBeUndefined()
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

  /**
   * The message-queue channel (#97). The capability is answered from two facts
   * on the registry row the scan already read — the plain source tag and the
   * build that opened the thread — and from nothing else. See queue.ts for what
   * the live experiment actually proved and what it did not.
   */
  describe('textDelivery over the Codex message queue', () => {
    it('offers the queue to a cli-source thread on a new enough Codex', async () => {
      seedLiveThread({ source: 'cli', cliVersion: '0.151.0' })
      const provider = makeProvider()
      await provider.scan()
      // The addressed id is the thread UUID itself, which is what `codex queue
      // --thread` takes; no translation and no second read.
      expect(provider.textDelivery('codex:' + LIVE_ID)).toEqual({
        kind: 'codex-queue',
        threadId: LIVE_ID
      })
    })

    it('offers no channel to a desktop-app thread, whose drain nobody has watched', async () => {
      seedLiveThread({ source: 'vscode', cliVersion: '0.151.0' })
      const provider = makeProvider()
      await provider.scan()
      expect(provider.textDelivery('codex:' + LIVE_ID)).toBeNull()
    })

    it('offers no channel to a thread opened by a Codex older than the floor', async () => {
      seedLiveThread({ source: 'cli', cliVersion: '0.148.0' })
      const provider = makeProvider()
      await provider.scan()
      expect(provider.textDelivery('codex:' + LIVE_ID)).toBeNull()
    })

    it('offers no channel when the row records no version at all', async () => {
      seedLiveThread({ source: 'cli' })
      const provider = makeProvider()
      await provider.scan()
      expect(provider.textDelivery('codex:' + LIVE_ID)).toBeNull()
    })

    /**
     * A sub-agent thread carries the spawn blob in `threads.source`, so it has
     * no plain tag: a Codex worker owns no queue anyone has watched drain, and
     * it gets no foreman hop either — the parent's queue is the parent's.
     */
    it('offers no channel to a sub-agent thread even under a queue-capable parent', async () => {
      seedLiveThread({ source: 'cli', cliVersion: '0.151.0' })
      const childId = '01a04d79-0000-7a31-9b1a-000000000001'
      fake.addFile(rolloutPathFor(childId), busyRollout(childId), NOW - 10_000)
      sqlite.exec(
        STATE_DB,
        threadInsert({
          id: childId,
          cwd: 'C:\\proj',
          rolloutPath: rolloutPathFor(childId),
          updatedAtMs: NOW - 10_000,
          cliVersion: '0.151.0',
          source: subagentSource(LIVE_ID, 'Bernoulli')
        })
      )
      const provider = makeProvider()
      await provider.scan()
      expect(provider.textDelivery('codex:' + childId)).toBeNull()
      expect(provider.textDelivery('codex:' + LIVE_ID)).toEqual({
        kind: 'codex-queue',
        threadId: LIVE_ID
      })
    })

    it('offers no channel for a rollout the registry never recorded', async () => {
      fake.addFile(LIVE_ROLLOUT, idleRollout(LIVE_ID), NOW - 30_000)
      const provider = makeProvider()
      await provider.scan()
      expect(provider.textDelivery('codex:' + LIVE_ID)).toBeNull()
    })

    it('offers no channel for an unknown dwarf id', async () => {
      seedLiveThread({ source: 'cli', cliVersion: '0.151.0' })
      const provider = makeProvider()
      await provider.scan()
      expect(provider.textDelivery('codex:nobody')).toBeNull()
    })

    /**
     * The map is rebuilt per scan and swapped in one assignment, exactly as
     * feedSources is (#12): a session that has ended must not keep answering
     * with a queue address, and a click landing mid-scan must never read a
     * half-rebuilt map.
     */
    it('stops offering the queue once the thread is gone from a later scan', async () => {
      seedLiveThread({ source: 'cli', cliVersion: '0.151.0' })
      const provider = makeProvider()
      await provider.scan()
      expect(provider.textDelivery('codex:' + LIVE_ID)).not.toBeNull()

      // Same provider, second scan: the session has ended and been archived.
      fake.removeFile(LIVE_ROLLOUT)
      sqlite.exec(STATE_DB, `UPDATE threads SET archived = 1 WHERE id = '${LIVE_ID}'`)
      await provider.scan()
      expect(provider.textDelivery('codex:' + LIVE_ID)).toBeNull()
    })
  })

  /**
   * The other question the same registry row answers (#231).
   *
   * A headless `codex exec` run has no channel here and, once this app has
   * restarted, no exit either — and the panel used to meet both with the
   * generic "this session type can't receive messages yet", which describes a
   * missing feature rather than a session that reads one prompt and leaves.
   * What crosses is the FACT, and the sentence is the renderer's.
   */
  describe('a session with one prompt and one turn (#231)', () => {
    async function dwarfFor(overrides: Partial<Parameters<typeof threadInsert>[0]>) {
      seedLiveThread(overrides)
      const [snapshot] = await makeProvider().scan()
      return snapshot?.dwarfs.find((dwarf) => dwarf.sessionId === LIVE_ID)
    }

    it('says so of a headless run, whoever started it', async () => {
      expect((await dwarfFor({ source: 'exec' }))?.oneShot).toBe(true)
    })

    /*
     * Absence claims nothing, and must not: a TUI somebody is sitting in front
     * of takes many turns, and so does the desktop app. Saying otherwise would
     * tell a person their live session cannot be reached.
     */
    it('says nothing of a session somebody is sitting in front of', async () => {
      expect((await dwarfFor({ source: 'cli' }))?.oneShot).toBeUndefined()
    })

    it('says nothing of the desktop app', async () => {
      expect((await dwarfFor({ source: 'vscode' }))?.oneShot).toBeUndefined()
    })

    it('says nothing of a tag this build does not know', async () => {
      expect((await dwarfFor({ source: 'something-new' }))?.oneShot).toBeUndefined()
    })

    /*
     * Read off the REGISTRY row, exactly as the queue capability is (#97): a
     * rollout the registry never recorded proves nothing about the shape of
     * the session that wrote it.
     */
    it('says nothing of a rollout the registry never recorded', async () => {
      fake.addFile(LIVE_ROLLOUT, idleRollout(LIVE_ID), NOW - 30_000)
      const [snapshot] = await makeProvider().scan()
      expect(snapshot?.dwarfs.find((dwarf) => dwarf.sessionId === LIVE_ID)?.oneShot).toBeUndefined()
    })
  })

  /**
   * Issue #264: a Codex session started from the terminal after the previous
   * one in the same folder closed.
   *
   * The second session is a brand-new thread whose registry row has not been
   * stamped yet — `updated_at_ms` NULL, `recency_at_ms` at its 0 default — and
   * whose rollout was created moments ago, so on Windows its mtime is already
   * frozen at whatever it was born with (issue #1). Everything the provider
   * used to read about that row said "0", which is before every cutoff.
   */
  describe('a session relaunched in the same cwd after the previous one closed (#264)', () => {
    const CLOSED_ID = '01a04d79-1111-7a31-9b1a-00000000aaaa'
    const RELAUNCHED_ID = '01a04d7f-2222-7a31-9b1a-00000000bbbb'
    /**
     * Registry spelling and rollout spelling of ONE folder — the fixture
     * rollout's own session_meta.cwd, so both sessions really do land in the
     * same mine and nothing here turns on a fixture mismatch.
     */
    const CWD = '\\\\?\\C:\\Users\\j\\Desktop\\Sample-Project'
    const CWD_SHOWN = 'C:\\Users\\j\\Desktop\\Sample-Project'
    /** Well past livenessWindowS + idleRetentionS, so the closed session cannot linger. */
    const LATER = NOW + (WINDOW_S + RETENTION_S) * 1_000 + 60_000

    /** One provider across both scans, since the gate compares against what it saw last tick. */
    function relaunchProvider(clock: { now: number }): CodexProvider {
      return makeProvider({ now: () => clock.now })
    }

    /** The first session: busy, registered, and stamped normally. */
    function seedClosedSession(): void {
      fake.addFile(rolloutPathFor(CLOSED_ID), busyRollout(CLOSED_ID), NOW - 30_000)
      sqlite.exec(
        STATE_DB,
        threadInsert({
          id: CLOSED_ID,
          cwd: CWD,
          rolloutPath: rolloutPathFor(CLOSED_ID),
          model: 'gpt-5.6-terra',
          updatedAtMs: NOW - 30_000
        })
      )
    }

    /**
     * The second session, as it exists on its very first scan: a row carrying
     * nothing but its creation stamp, in the same folder.
     */
    function seedRelaunchedRow(createdAtMs: number, rolloutOnDisk: boolean): void {
      if (rolloutOnDisk) {
        fake.addFile(rolloutPathFor(RELAUNCHED_ID), busyRollout(RELAUNCHED_ID), createdAtMs)
      }
      sqlite.exec(
        STATE_DB,
        threadInsert({
          id: RELAUNCHED_ID,
          cwd: CWD,
          rolloutPath: rolloutPathFor(RELAUNCHED_ID),
          model: 'gpt-5.6-luna',
          effort: 'high',
          cliVersion: '0.151.0',
          createdAtMs
        })
      )
    }

    it('shows the relaunched session and nothing of the one that closed', async () => {
      const clock = { now: NOW }
      const provider = relaunchProvider(clock)
      seedClosedSession()
      expect((await provider.scan()).map((s) => s.sessionId)).toEqual([CLOSED_ID])

      clock.now = LATER
      seedRelaunchedRow(LATER - 5_000, true)
      const snapshots = await provider.scan()
      expect(snapshots.map((s) => s.sessionId)).toEqual([RELAUNCHED_ID])
      expect(snapshots[0]!.cwd).toBe(CWD_SHOWN)
      expect(snapshots[0]!.dwarfs.map((dwarf) => dwarf.id)).toEqual(['codex:' + RELAUNCHED_ID])
    })

    /**
     * The half the rollout file cannot cover. A relaunched session found only
     * by the day-directory walk is a nameless dwarf: no model, no effort, no
     * queue address — every one of those is a registry fact (#97), and the
     * unstamped row was being skipped.
     */
    it('reads the relaunched session off its registry row, not just its rollout', async () => {
      const clock = { now: NOW }
      const provider = relaunchProvider(clock)
      seedClosedSession()
      await provider.scan()

      clock.now = LATER
      seedRelaunchedRow(LATER - 5_000, true)
      const [snapshot] = await provider.scan()
      expect(snapshot!.dwarfs[0]).toMatchObject({ model: 'gpt-5.6-luna', effort: 'high' })
      expect(provider.textDelivery('codex:' + RELAUNCHED_ID)).toEqual({
        kind: 'codex-queue',
        threadId: RELAUNCHED_ID
      })
    })

    /**
     * And the case where the file cannot save the session at all: the row is
     * written when the thread opens, so a scan landing before the rollout is
     * readable has the registry as its only evidence — which is exactly the
     * tick the panel had nothing on the board for.
     */
    it('shows a relaunched session whose rollout is not readable yet', async () => {
      const clock = { now: NOW }
      const provider = relaunchProvider(clock)
      seedClosedSession()
      await provider.scan()

      clock.now = LATER
      seedRelaunchedRow(LATER - 5_000, false)
      const snapshots = await provider.scan()
      expect(snapshots.map((s) => s.sessionId)).toEqual([RELAUNCHED_ID])
      expect(snapshots[0]!.cwd).toBe(CWD_SHOWN)
    })

    it('leaves a session created long ago and never touched since off the board', async () => {
      const clock = { now: NOW }
      const provider = relaunchProvider(clock)
      seedClosedSession()
      await provider.scan()

      clock.now = LATER
      // Created before the closed session and never stamped again: creation is
      // freshness only while the creation itself is recent.
      seedRelaunchedRow(NOW - 30_000, false)
      expect(await provider.scan()).toEqual([])
    })

    /**
     * The strictest form of #264's own diagnosis, pinned so it cannot silently
     * come back: creation is the ONLY signal left. The rollout is on disk with
     * a frozen mtime (#1), the row carries `updated_at_ms` NULL and
     * `recency_at_ms` 0, and no log row has been written yet — a first scan
     * lands between the thread opening and its first turn producing anything.
     * Every other test above leaves the rollout's own fresh mtime standing.
     */
    it('rediscovers the relaunched session on its creation stamp alone', async () => {
      const clock = { now: NOW }
      const provider = relaunchProvider(clock)
      seedClosedSession()
      await provider.scan()

      clock.now = LATER
      // Written moments ago, but its mtime reads hours old: exactly the freeze
      // §4 measured on a rollout Codex still holds open.
      fake.addFile(rolloutPathFor(RELAUNCHED_ID), busyRollout(RELAUNCHED_ID), FROZEN_MTIME)
      sqlite.exec(
        STATE_DB,
        threadInsert({
          id: RELAUNCHED_ID,
          cwd: CWD,
          rolloutPath: rolloutPathFor(RELAUNCHED_ID),
          createdAtMs: LATER - 5_000
        })
      )
      expect((await provider.scan()).map((s) => s.sessionId)).toEqual([RELAUNCHED_ID])
    })
  })

  /**
   * Issue #264, the surface the report's own diagnosis did not reach: a thread
   * whose registry stamps have aged past the retention floor while Codex is
   * writing log rows for it right now.
   *
   * `logs` is this provider's strongest liveness signal and the whole reason
   * the heartbeat leg exists (see the module comment in state.ts): rows are
   * appended continuously while a turn runs, which is precisely what a frozen
   * Windows mtime cannot say. But the heartbeat is joined to a candidate
   * through its registry row, and that row was being filtered out by the same
   * retention floor the heartbeat exists to overrule — so the freshest evidence
   * on the machine was read, kept in a map, and never consulted.
   *
   * Reached by `codex resume`, which §8 measured opening an old thread in a new
   * process while keeping its id: whether Codex re-stamps `updated_at_ms` and
   * `recency_at_ms` when it does is UNMEASURED, and this is what it costs when
   * it does not.
   */
  describe('a thread whose registry stamps aged out while it is still logging (#264)', () => {
    /** Older than livenessWindowS + idleRetentionS: below every registry cutoff. */
    const STALE_MS = NOW - (WINDOW_S + RETENTION_S) * 1_000 - 60_000

    function seedStaleRowWithHeartbeat(heartbeatAgoS: number): void {
      fake.addFile(LIVE_ROLLOUT, busyRollout(LIVE_ID), FROZEN_MTIME)
      sqlite.exec(
        STATE_DB,
        threadInsert({
          id: LIVE_ID,
          cwd: '\\\\?\\C:\\Users\\j\\Desktop\\Sample-Project',
          rolloutPath: LIVE_ROLLOUT,
          model: 'gpt-5.6-luna',
          createdAtMs: STALE_MS,
          updatedAtMs: STALE_MS,
          recencyAtMs: STALE_MS
        })
      )
      sqlite.exec(LOGS_DB, logInsert(LIVE_ID, (NOW - heartbeatAgoS * 1_000) / 1_000))
    }

    it('keeps a session whose only fresh signal is its own logs heartbeat', async () => {
      seedStaleRowWithHeartbeat(30)
      const snapshots = await makeProvider().scan()
      expect(snapshots.map((s) => s.sessionId)).toEqual([LIVE_ID])
    })

    /**
     * And the registry facts come with it. A session rescued as a bare rollout
     * would be a nameless dwarf with no model and no queue address (#97) — the
     * heartbeat names a THREAD, so the row it names has to arrive too.
     */
    it('describes that session from its registry row, not from its rollout alone', async () => {
      seedStaleRowWithHeartbeat(30)
      const [snapshot] = await makeProvider().scan()
      expect(snapshot!.cwd).toBe('C:\\Users\\j\\Desktop\\Sample-Project')
      expect(snapshot!.dwarfs[0]).toMatchObject({ model: 'gpt-5.6-luna' })
    })

    /**
     * The other direction, and the reason this is not a way back for every dead
     * rollout on the machine: the exemption is a log row inside the heartbeat
     * window for that one thread, so a thread that stopped logging stays off.
     */
    it('leaves a stale thread off when its last log row is older than the heartbeat window', async () => {
      seedStaleRowWithHeartbeat(WINDOW_S + 60)
      expect(await makeProvider().scan()).toEqual([])
    })
  })
})
