import { beforeEach, describe, expect, it } from 'vitest'
import { MemorySqlite } from '../../adapters/memorySqlite'
import {
  CODEX_LOGS_SCHEMA,
  CODEX_STATE_SCHEMA,
  logInsert,
  spawnEdgeInsert,
  subagentSource,
  threadInsert
} from './stateSeed'
import {
  CODEX_EXEC_SOURCE_TAG,
  isCodexOneShotThread,
  normalizeCodexCwd,
  parseCodexThreadSource,
  readCodexCliVersions,
  readCodexHeartbeats,
  readCodexSpawnEdges,
  readCodexThreads
} from './state'

const STATE_DB = 'C:\\Users\\j\\.codex\\state_5.sqlite'
const LOGS_DB = 'C:\\Users\\j\\.codex\\logs_2.sqlite'

const NOW = new Date(2026, 7, 29, 12, 0, 0).getTime()

describe('normalizeCodexCwd', () => {
  // threads.cwd carries the Windows extended-length prefix while a rollout's
  // session_meta.cwd does not. Left as-is, the same project would show up as
  // two separate mines.
  it('strips the Windows extended-length prefix', () => {
    expect(normalizeCodexCwd('\\\\?\\C:\\Users\\j\\Desktop\\Sample-Project\\agent-name')).toBe(
      'C:\\Users\\j\\Desktop\\Sample-Project\\agent-name'
    )
  })

  it('leaves an ordinary path untouched', () => {
    expect(normalizeCodexCwd('C:\\Users\\j\\project')).toBe('C:\\Users\\j\\project')
    expect(normalizeCodexCwd('/home/j/project')).toBe('/home/j/project')
  })

  it('keeps a real UNC network path intact', () => {
    expect(normalizeCodexCwd('\\\\server\\share\\project')).toBe('\\\\server\\share\\project')
  })
})

describe('parseCodexThreadSource', () => {
  it('reports no parent for a plain cli or vscode thread', () => {
    expect(parseCodexThreadSource('cli')).toEqual({})
    expect(parseCodexThreadSource('vscode')).toEqual({})
  })

  it('extracts the parent thread and nickname from a sub-agent spawn blob', () => {
    const source = JSON.stringify({
      subagent: {
        thread_spawn: {
          parent_thread_id: '01a04d79-5c87-7a31-9b1a-4aacc350d6fd',
          depth: 1,
          agent_path: '/root/quality_audit',
          agent_nickname: 'Bernoulli',
          agent_role: null
        }
      }
    })
    // Amended for #218: `agentPath` joins the exact shape this asserts. The
    // blob always carried it and this reader threw it away, which is why the
    // panel could not say what a spawned agent was working on.
    expect(parseCodexThreadSource(source)).toEqual({
      parentThreadId: '01a04d79-5c87-7a31-9b1a-4aacc350d6fd',
      agentName: 'Bernoulli',
      agentPath: '/root/quality_audit'
    })
  })

  it('keeps the agent path the blob names, which is the only field stating the objective', () => {
    // #218. A Codex child thread is a FORK: its first role:'user' item is the
    // human's original prompt, not the parent's instruction, and there is no
    // event_msg/user_message at all — so no readable line states what it was
    // asked to do. `agent_path` is the field that does. It is read verbatim,
    // never prettified: nothing here parses prose or infers an intent.
    const source = JSON.stringify({
      subagent: { thread_spawn: { agent_path: '/root/audit_chain_report' } }
    })
    expect(parseCodexThreadSource(source).agentPath).toBe('/root/audit_chain_report')
  })

  it('omits the agent path when the blob carried none, rather than inventing an empty one', () => {
    const source = JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: 'p' } } })
    expect(parseCodexThreadSource(source)).toEqual({ parentThreadId: 'p' })
  })

  it('ignores a subagent blob with no thread_spawn', () => {
    expect(parseCodexThreadSource('{"subagent":{"other":"guardian"}}')).toEqual({})
  })

  it('ignores malformed json instead of throwing', () => {
    expect(parseCodexThreadSource('{not json')).toEqual({})
    expect(parseCodexThreadSource(null)).toEqual({})
  })
})

describe('readCodexThreads', () => {
  let sqlite: MemorySqlite

  beforeEach(() => {
    sqlite = new MemorySqlite()
    sqlite.define(STATE_DB, CODEX_STATE_SCHEMA)
  })

  async function read(sinceMs: number) {
    const db = await sqlite.openReadOnly(STATE_DB)
    return readCodexThreads(db!, sinceMs)
  }

  it('maps a live thread row to cwd, model, effort and tokens', async () => {
    sqlite.exec(
      STATE_DB,
      threadInsert({
        id: 'thread-1',
        cwd: '\\\\?\\C:\\Users\\j\\Desktop\\Sample-Project\\agent-name',
        rolloutPath: 'C:\\rollouts\\rollout-thread-1.jsonl',
        model: 'gpt-5.6-luna',
        effort: 'medium',
        tokensUsed: 19343971,
        updatedAtMs: NOW - 1_000
      })
    )
    expect(await read(NOW - 60_000)).toEqual([
      {
        threadId: 'thread-1',
        cwd: 'C:\\Users\\j\\Desktop\\Sample-Project\\agent-name',
        rolloutPath: 'C:\\rollouts\\rollout-thread-1.jsonl',
        model: 'gpt-5.6-luna',
        effort: 'medium',
        tokensUsed: 19343971,
        updatedAtMs: NOW - 1_000,
        // threadInsert defaults source to 'cli'; carried on the row since #97.
        sourceTag: 'cli'
      }
    ])
  })

  it('uses the freshest of updated_at_ms and recency_at_ms', async () => {
    sqlite.exec(
      STATE_DB,
      threadInsert({
        id: 'thread-1',
        cwd: 'C:\\p',
        updatedAtMs: NOW - 9_000,
        recencyAtMs: NOW - 2_000
      })
    )
    expect((await read(NOW - 60_000))[0]!.updatedAtMs).toBe(NOW - 2_000)
  })

  it('still reports a thread whose updated_at_ms is null', async () => {
    sqlite.exec(STATE_DB, threadInsert({ id: 'thread-1', cwd: 'C:\\p', recencyAtMs: NOW - 2_000 }))
    expect((await read(NOW - 60_000)).map((t) => t.threadId)).toEqual(['thread-1'])
  })

  /**
   * #264. A thread row that has only just been created carries no freshness at
   * all in the two columns this reader used to look at: `updated_at_ms` is
   * nullable and arrives NULL, `recency_at_ms` is NOT NULL DEFAULT 0 and
   * arrives 0. Both floor to 0, which is before every cutoff, so the row was
   * invisible for as long as it stayed unstamped — and the session that opened
   * it lost its cwd, model and queue address with it.
   */
  it('reports a just-created thread whose only stamp is created_at_ms', async () => {
    sqlite.exec(
      STATE_DB,
      threadInsert({ id: 'fresh', cwd: 'C:\\p', model: 'gpt-5.6-luna', createdAtMs: NOW - 2_000 })
    )
    expect((await read(NOW - 60_000))[0]).toMatchObject({
      threadId: 'fresh',
      model: 'gpt-5.6-luna',
      updatedAtMs: NOW - 2_000
    })
  })

  it('uses the freshest of created_at_ms, updated_at_ms and recency_at_ms', async () => {
    sqlite.exec(
      STATE_DB,
      threadInsert({
        id: 'thread-1',
        cwd: 'C:\\p',
        createdAtMs: NOW - 9_000,
        updatedAtMs: NOW - 5_000,
        recencyAtMs: NOW - 2_000
      })
    )
    expect((await read(NOW - 60_000))[0]!.updatedAtMs).toBe(NOW - 2_000)
  })

  it('never lets a stale creation stamp hold an abandoned thread open', async () => {
    // Creation is a freshness signal only while it is itself recent: a thread
    // created ten days ago and never touched since must stay out.
    sqlite.exec(
      STATE_DB,
      threadInsert({ id: 'old', cwd: 'C:\\p', createdAtMs: NOW - 10 * 24 * 3600_000 })
    )
    expect(await read(NOW - 60_000)).toEqual([])
  })

  it('excludes archived threads', async () => {
    sqlite.exec(STATE_DB, threadInsert({ id: 'gone', cwd: 'C:\\p', updatedAtMs: NOW, archived: 1 }))
    expect(await read(NOW - 60_000)).toEqual([])
  })

  it('excludes threads untouched since the cutoff', async () => {
    sqlite.exec(
      STATE_DB,
      threadInsert({ id: 'old', cwd: 'C:\\p', updatedAtMs: NOW - 10 * 24 * 3600_000 })
    )
    expect(await read(NOW - 60_000)).toEqual([])
  })

  /**
   * The heartbeat exemption (#264). A thread is reached through its row, so a
   * row dropped here takes its own logs heartbeat with it — the freshest thing
   * the provider knows, and the one a frozen Windows mtime cannot contradict.
   */
  it('keeps a thread below the cutoff when the caller names it as still logging', async () => {
    sqlite.exec(
      STATE_DB,
      threadInsert({ id: 'logging', cwd: 'C:\\p', updatedAtMs: NOW - 10 * 24 * 3600_000 })
    )
    const db = await sqlite.openReadOnly(STATE_DB)
    expect(readCodexThreads(db!, NOW - 60_000, ['logging']).map((t) => t.threadId)).toEqual([
      'logging'
    ])
  })

  it('still excludes an archived thread the caller names', async () => {
    sqlite.exec(STATE_DB, threadInsert({ id: 'gone', cwd: 'C:\\p', updatedAtMs: NOW, archived: 1 }))
    const db = await sqlite.openReadOnly(STATE_DB)
    expect(readCodexThreads(db!, NOW - 60_000, ['gone'])).toEqual([])
  })

  it('names only the threads asked for, leaving every other stale row out', async () => {
    const stale = NOW - 10 * 24 * 3600_000
    sqlite.exec(STATE_DB, threadInsert({ id: 'logging', cwd: 'C:\\p', updatedAtMs: stale }))
    sqlite.exec(STATE_DB, threadInsert({ id: 'quiet', cwd: 'C:\\p', updatedAtMs: stale }))
    const db = await sqlite.openReadOnly(STATE_DB)
    expect(readCodexThreads(db!, NOW - 60_000, ['logging']).map((t) => t.threadId)).toEqual([
      'logging'
    ])
  })

  it('carries the sub-agent parent and nickname from the source blob', async () => {
    sqlite.exec(
      STATE_DB,
      threadInsert({
        id: 'child',
        cwd: 'C:\\p',
        updatedAtMs: NOW,
        agentNickname: 'Bernoulli',
        source: subagentSource('parent', 'Bernoulli')
      })
    )
    expect((await read(NOW - 60_000))[0]).toMatchObject({
      threadId: 'child',
      parentThreadId: 'parent',
      agentName: 'Bernoulli'
    })
  })

  it("carries the spawned agent's objective path from the source blob (#218)", async () => {
    sqlite.exec(
      STATE_DB,
      threadInsert({
        id: 'child',
        cwd: 'C:\p',
        updatedAtMs: NOW,
        source: subagentSource('parent', 'Bernoulli', '/root/audit_chain_report')
      })
    )
    expect((await read(NOW - 60_000))[0]?.agentPath).toBe('/root/audit_chain_report')
  })

  it('leaves a root thread with no objective path at all', async () => {
    // A root was nobody's spawn, so there is no agent definition behind it —
    // and the human who typed its prompt is the objective's author.
    sqlite.exec(STATE_DB, threadInsert({ id: 'root', cwd: 'C:\p', updatedAtMs: NOW }))
    expect((await read(NOW - 60_000))[0]?.agentPath).toBeUndefined()
  })

  it('omits model, effort and tokens when the row has none', async () => {
    sqlite.exec(STATE_DB, threadInsert({ id: 'bare', cwd: 'C:\\p', updatedAtMs: NOW }))
    const thread = (await read(NOW - 60_000))[0]!
    expect(thread.model).toBeUndefined()
    expect(thread.effort).toBeUndefined()
    expect(thread.tokensUsed).toBeUndefined()
  })

  it('returns [] when the database has no threads table (older Codex)', async () => {
    const bare = new MemorySqlite()
    bare.define('bare', 'CREATE TABLE unrelated (x TEXT)')
    const db = await bare.openReadOnly('bare')
    expect(readCodexThreads(db!, 0)).toEqual([])
  })

  /**
   * `threads.source` was read only for sub-agent identity until #97. The plain
   * tag is what decides whether a thread's message queue is one anybody has
   * watched drain, so it now travels on the row as well.
   */
  it('carries the plain source tag of a cli or desktop-app thread', async () => {
    sqlite.exec(
      STATE_DB,
      threadInsert({ id: 'tui', cwd: 'C:\\p', updatedAtMs: NOW, source: 'cli' })
    )
    sqlite.exec(
      STATE_DB,
      threadInsert({ id: 'app', cwd: 'C:\\p', updatedAtMs: NOW - 1, source: 'vscode' })
    )
    const threads = await read(NOW - 60_000)
    expect(threads.map((t) => [t.threadId, t.sourceTag])).toEqual([
      ['tui', 'cli'],
      ['app', 'vscode']
    ])
  })

  /*
   * The same tag answering a second question (#231): a headless run reads one
   * prompt and exits with its turn, so nobody can talk to it whether or not
   * this app started it — and the panel has to say that rather than the
   * generic "can't receive messages yet".
   */
  it('carries the tag a headless run writes, distinct from the cli one', async () => {
    sqlite.exec(
      STATE_DB,
      threadInsert({ id: 'headless', cwd: 'C:\\p', updatedAtMs: NOW, source: 'exec' })
    )
    const [thread] = await read(NOW - 60_000)
    expect(thread?.sourceTag).toBe(CODEX_EXEC_SOURCE_TAG)
    expect(isCodexOneShotThread(thread ?? {})).toBe(true)
  })

  it('reports no source tag for a sub-agent thread, whose source is the spawn blob', async () => {
    sqlite.exec(
      STATE_DB,
      threadInsert({
        id: 'child',
        cwd: 'C:\\p',
        updatedAtMs: NOW,
        source: subagentSource('parent', 'Bernoulli')
      })
    )
    expect((await read(NOW - 60_000))[0]!.sourceTag).toBeUndefined()
  })
})

describe('readCodexCliVersions', () => {
  let sqlite: MemorySqlite

  beforeEach(() => {
    sqlite = new MemorySqlite()
    sqlite.define(STATE_DB, CODEX_STATE_SCHEMA)
  })

  async function read() {
    const db = await sqlite.openReadOnly(STATE_DB)
    return readCodexCliVersions(db!)
  }

  it('maps each thread to the Codex build that opened it', async () => {
    sqlite.exec(STATE_DB, threadInsert({ id: 'new', cwd: 'C:\\p', cliVersion: '0.151.0' }))
    sqlite.exec(STATE_DB, threadInsert({ id: 'old', cwd: 'C:\\p', cliVersion: '0.148.0' }))
    expect([...(await read())]).toEqual([
      ['new', '0.151.0'],
      ['old', '0.148.0']
    ])
  })

  // cli_version is NOT NULL DEFAULT '', so "never written" is a blank string.
  // Omitting it is what makes the version floor refuse the thread.
  it('omits a thread whose version column was never written', async () => {
    sqlite.exec(STATE_DB, threadInsert({ id: 'blank', cwd: 'C:\\p' }))
    expect((await read()).size).toBe(0)
  })

  /**
   * Read in its own query rather than folded into THREADS_SQL on purpose: a
   * Codex whose `threads` table predates this column would otherwise fail the
   * whole registry read and lose model, effort, tokens and the sub-agent graph
   * for every session — a heavy price for a capability that install cannot use
   * anyway. Here the same schema gap costs only the version.
   */
  it('returns an empty map when the column or table is missing, leaving threads readable', async () => {
    const older = new MemorySqlite()
    older.define(
      'older',
      'CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, archived INTEGER)'
    )
    const db = await older.openReadOnly('older')
    expect(readCodexCliVersions(db!).size).toBe(0)
  })
})

describe('readCodexSpawnEdges', () => {
  it('maps each child thread to its parent', async () => {
    const sqlite = new MemorySqlite()
    sqlite.define(STATE_DB, CODEX_STATE_SCHEMA, [
      spawnEdgeInsert('parent', 'child-a'),
      spawnEdgeInsert('parent', 'child-b', 'closed')
    ])
    const db = await sqlite.openReadOnly(STATE_DB)
    expect([...readCodexSpawnEdges(db!)]).toEqual([
      ['child-a', 'parent'],
      ['child-b', 'parent']
    ])
  })

  it('returns an empty map when the table is missing', async () => {
    const bare = new MemorySqlite()
    bare.define('bare', 'CREATE TABLE unrelated (x TEXT)')
    const db = await bare.openReadOnly('bare')
    expect(readCodexSpawnEdges(db!).size).toBe(0)
  })
})

describe('readCodexHeartbeats', () => {
  let sqlite: MemorySqlite

  beforeEach(() => {
    sqlite = new MemorySqlite()
    sqlite.define(LOGS_DB, CODEX_LOGS_SCHEMA)
  })

  async function read(sinceMs: number) {
    const db = await sqlite.openReadOnly(LOGS_DB)
    return readCodexHeartbeats(db!, sinceMs)
  }

  it('returns the newest log timestamp per thread, in milliseconds', async () => {
    const nowS = Math.floor(NOW / 1_000)
    sqlite.exec(LOGS_DB, logInsert('thread-1', nowS - 30))
    sqlite.exec(LOGS_DB, logInsert('thread-1', nowS - 5))
    sqlite.exec(LOGS_DB, logInsert('thread-2', nowS - 10))
    // logs.ts is UNIX SECONDS; the provider works in milliseconds.
    expect([...(await read(NOW - 60_000))]).toEqual([
      ['thread-1', (nowS - 5) * 1_000],
      ['thread-2', (nowS - 10) * 1_000]
    ])
  })

  it('ignores rows older than the window and app-server rows with no thread', async () => {
    const nowS = Math.floor(NOW / 1_000)
    sqlite.exec(LOGS_DB, logInsert('stale', nowS - 5_000))
    sqlite.exec(LOGS_DB, logInsert(null, nowS))
    expect((await read(NOW - 60_000)).size).toBe(0)
  })

  it('returns an empty map when the logs table is missing', async () => {
    const bare = new MemorySqlite()
    bare.define('bare', 'CREATE TABLE unrelated (x TEXT)')
    const db = await bare.openReadOnly('bare')
    expect(readCodexHeartbeats(db!, 0).size).toBe(0)
  })
})

/*
 * #231. The panel needs one fact about a session nobody can talk to: that its
 * whole life is one prompt and one turn. Absence must claim nothing — a build
 * spelling the tag otherwise leaves the panel saying what it said before,
 * rather than something wrong about a session it has misread.
 */
describe('isCodexOneShotThread', () => {
  it('reads the headless tag as a session with no inbox', () => {
    expect(isCodexOneShotThread({ sourceTag: 'exec' })).toBe(true)
  })

  it('claims nothing about a session somebody is sitting in front of', () => {
    // 'cli' is a TUI a human types into, 'vscode' the desktop app. Both take
    // more than one turn, whatever channel this app has for reaching them.
    expect(isCodexOneShotThread({ sourceTag: 'cli' })).toBe(false)
    expect(isCodexOneShotThread({ sourceTag: 'vscode' })).toBe(false)
  })

  it('claims nothing about a tag it does not recognise, or none at all', () => {
    expect(isCodexOneShotThread({})).toBe(false)
    expect(isCodexOneShotThread({ sourceTag: 'something-new' })).toBe(false)
    // A sub-agent's source column is the spawn blob, so it carries no tag —
    // and a spawned agent is not a headless run in any case.
    expect(isCodexOneShotThread({ sourceTag: undefined })).toBe(false)
  })
})
