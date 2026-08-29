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
  normalizeCodexCwd,
  parseCodexThreadSource,
  readCodexHeartbeats,
  readCodexSpawnEdges,
  readCodexThreads
} from './state'

const STATE_DB = 'C:\\Users\\jeron\\.codex\\state_5.sqlite'
const LOGS_DB = 'C:\\Users\\jeron\\.codex\\logs_2.sqlite'

const NOW = new Date(2026, 7, 29, 12, 0, 0).getTime()

describe('normalizeCodexCwd', () => {
  // threads.cwd carries the Windows extended-length prefix while a rollout's
  // session_meta.cwd does not. Left as-is, the same project would show up as
  // two separate mines.
  it('strips the Windows extended-length prefix', () => {
    expect(normalizeCodexCwd('\\\\?\\C:\\Users\\jeron\\Desktop\\AI-Tools\\agent-name')).toBe(
      'C:\\Users\\jeron\\Desktop\\AI-Tools\\agent-name'
    )
  })

  it('leaves an ordinary path untouched', () => {
    expect(normalizeCodexCwd('C:\\Users\\jeron\\project')).toBe('C:\\Users\\jeron\\project')
    expect(normalizeCodexCwd('/home/jeron/project')).toBe('/home/jeron/project')
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
    expect(parseCodexThreadSource(source)).toEqual({
      parentThreadId: '01a04d79-5c87-7a31-9b1a-4aacc350d6fd',
      agentName: 'Bernoulli'
    })
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
        cwd: '\\\\?\\C:\\Users\\jeron\\Desktop\\AI-Tools\\agent-name',
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
        cwd: 'C:\\Users\\jeron\\Desktop\\AI-Tools\\agent-name',
        rolloutPath: 'C:\\rollouts\\rollout-thread-1.jsonl',
        model: 'gpt-5.6-luna',
        effort: 'medium',
        tokensUsed: 19343971,
        updatedAtMs: NOW - 1_000
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
