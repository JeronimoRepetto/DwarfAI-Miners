import { describe, expect, it } from 'vitest'
import { MemorySqlite } from '../../adapters/memorySqlite'
import {
  eventInsert,
  messageInsert,
  OPENCODE_SCHEMA,
  OPENCODE_UNKNOWN_SCHEMA,
  partInsert,
  sessionInsert
} from './stateSeed'
import {
  readOpenCodeEventSeqs,
  readOpenCodeMessages,
  readOpenCodeNewestAssistant,
  readOpenCodeSessions
} from './state'

/*
 * Issue #444. Real SQL against the measured 1.18.31 DDL (opencode-schema.sql)
 * — MemorySqlite runs the production statements, not a stubbed answer — and
 * against the synthetic unknown-schema database, which every query here must
 * answer with [] / an empty Map, never a throw (sqliteLike.ts's own error
 * contract, D2 "Thrown poll tick: Never").
 */

const REAL_PATH = '/store/opencode.db'
const UNKNOWN_PATH = '/store/opencode-unknown.db'

async function realDb() {
  const sqlite = new MemorySqlite()
  sqlite.define(REAL_PATH, OPENCODE_SCHEMA)
  const db = await sqlite.openReadOnly(REAL_PATH)
  if (db === null) throw new Error('expected a database')
  return { sqlite, db }
}

async function unknownDb() {
  const sqlite = new MemorySqlite()
  sqlite.define(UNKNOWN_PATH, OPENCODE_UNKNOWN_SCHEMA)
  const db = await sqlite.openReadOnly(UNKNOWN_PATH)
  if (db === null) throw new Error('expected a database')
  return db
}

describe('readOpenCodeSessions', () => {
  it('reads a non-archived session, including its parent_id', async () => {
    const { sqlite, db } = await realDb()
    sqlite.exec(
      REAL_PATH,
      sessionInsert({
        id: 'ses_child',
        directory: '/home/j/Sample-Project',
        parentId: 'ses_parent',
        agent: 'general',
        model: JSON.stringify({
          id: 'qwen3.6-plus',
          providerID: 'opencode-go',
          variant: 'default'
        }),
        timeCreatedMs: 1_000,
        timeUpdatedMs: 2_000
      })
    )
    const sessions = readOpenCodeSessions(db, 0)
    expect(sessions).toEqual([
      {
        sessionId: 'ses_child',
        cwd: '/home/j/Sample-Project',
        title: '',
        agent: 'general',
        modelId: 'qwen3.6-plus',
        parentSessionId: 'ses_parent',
        createdMs: 1_000,
        updatedMs: 2_000,
        tokensUsed: 0
      }
    ])
  })

  // AMENDED for #540: readOpenCodeSessions now sums session.tokens_* into one
  // tokensUsed number under the shared cross-provider definition (see
  // opencodeUsageTokens's own comment) — the SELECT #444 left off the columns
  // it measured populated, on the pending "maintainer question 3" the answer
  // to which is yes.
  it('sums the five token columns into tokensUsed, mirroring what Claude and Codex count', async () => {
    const { sqlite, db } = await realDb()
    sqlite.exec(REAL_PATH, sessionInsert({ id: 'ses_a', directory: '/home/j/p' }))
    sqlite.exec(
      REAL_PATH,
      `UPDATE session SET tokens_input = 100, tokens_output = 200, tokens_reasoning = 5, ` +
        `tokens_cache_read = 3, tokens_cache_write = 2 WHERE id = 'ses_a'`
    )
    expect(readOpenCodeSessions(db, 0)[0]?.tokensUsed).toBe(310)
  })

  it('reads an all-zero session as tokensUsed: 0, not undefined', async () => {
    const { sqlite, db } = await realDb()
    sqlite.exec(REAL_PATH, sessionInsert({ id: 'ses_a', directory: '/home/j/p' }))
    const session = readOpenCodeSessions(db, 0)[0]
    expect(session).toHaveProperty('tokensUsed')
    expect(session?.tokensUsed).toBe(0)
  })

  it('treats a NULL token column as 0, never a throw or a dropped row (#540)', async () => {
    // The real 1.18.31 schema declares these columns NOT NULL DEFAULT 0
    // (opencode-schema.sql), so this is defensive rather than observed — the
    // same posture asNumber() already takes for every other optional column,
    // proven here against a schema that allows the value the real one cannot.
    const path = '/store/opencode-nullable-tokens.db'
    const sqlite = new MemorySqlite()
    sqlite.define(
      path,
      `CREATE TABLE session (
        id text PRIMARY KEY, project_id text, workspace_id text, parent_id text,
        slug text, directory text NOT NULL, path text, title text, version text,
        cost real, tokens_input integer, tokens_output integer, tokens_reasoning integer,
        tokens_cache_read integer, tokens_cache_write integer,
        agent text, model text, time_created integer NOT NULL, time_updated integer NOT NULL,
        time_archived integer
      )`
    )
    sqlite.exec(
      path,
      `INSERT INTO session (id, directory, time_created, time_updated, tokens_input, ` +
        `tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write) VALUES ` +
        `('ses_a', '/home/j/p', 1000, 2000, NULL, NULL, NULL, NULL, NULL)`
    )
    const db = await sqlite.openReadOnly(path)
    if (db === null) throw new Error('expected a database')
    expect(readOpenCodeSessions(db, 0)[0]?.tokensUsed).toBe(0)
  })

  it('excludes an archived session', async () => {
    const { sqlite, db } = await realDb()
    sqlite.exec(
      REAL_PATH,
      sessionInsert({ id: 'ses_gone', directory: '/home/j/p', timeArchivedMs: 5_000 })
    )
    expect(readOpenCodeSessions(db, 0)).toEqual([])
  })

  it('reads a root session with no parent as having no parentSessionId', async () => {
    const { sqlite, db } = await realDb()
    sqlite.exec(REAL_PATH, sessionInsert({ id: 'ses_root', directory: '/home/j/p' }))
    expect(readOpenCodeSessions(db, 0)[0]).not.toHaveProperty('parentSessionId')
  })

  it('answers an unknown schema with no rows and no throw', async () => {
    const db = await unknownDb()
    expect(readOpenCodeSessions(db, 0)).toEqual([])
  })
})

describe('readOpenCodeEventSeqs', () => {
  it('reads the max seq per aggregate_id (session)', async () => {
    const { sqlite, db } = await realDb()
    sqlite.exec(REAL_PATH, eventInsert('e1', 'ses_a', 1))
    sqlite.exec(REAL_PATH, eventInsert('e2', 'ses_a', 5))
    sqlite.exec(REAL_PATH, eventInsert('e3', 'ses_b', 2))
    const seqs = readOpenCodeEventSeqs(db)
    expect(seqs.get('ses_a')).toBe(5)
    expect(seqs.get('ses_b')).toBe(2)
  })

  it('answers an unknown schema with an empty map and no throw', async () => {
    const db = await unknownDb()
    expect(readOpenCodeEventSeqs(db).size).toBe(0)
  })
})

describe('readOpenCodeNewestAssistant', () => {
  it('reads the newest assistant message per session, skipping a newer user message', async () => {
    const { sqlite, db } = await realDb()
    sqlite.exec(REAL_PATH, sessionInsert({ id: 'ses_a', directory: '/home/j/p' }))
    sqlite.exec(
      REAL_PATH,
      messageInsert({
        id: 'm1',
        sessionId: 'ses_a',
        timeCreatedMs: 1_000,
        data: { role: 'user', time: { created: 1_000 } }
      })
    )
    sqlite.exec(
      REAL_PATH,
      messageInsert({
        id: 'm2',
        sessionId: 'ses_a',
        timeCreatedMs: 2_000,
        data: { role: 'assistant', time: { created: 2_000, completed: 2_500 }, finish: 'stop' }
      })
    )
    sqlite.exec(
      REAL_PATH,
      messageInsert({
        id: 'm3',
        sessionId: 'ses_a',
        timeCreatedMs: 3_000,
        data: { role: 'user', time: { created: 3_000 } }
      })
    )
    const newest = readOpenCodeNewestAssistant(db, ['ses_a'])
    expect(newest.get('ses_a')).toEqual({
      role: 'assistant',
      timeCreatedMs: 2_000,
      timeCompletedMs: 2_500,
      finish: 'stop'
    })
  })

  it('answers no entry for a session with no assistant message yet', async () => {
    const { sqlite, db } = await realDb()
    sqlite.exec(REAL_PATH, sessionInsert({ id: 'ses_a', directory: '/home/j/p' }))
    sqlite.exec(
      REAL_PATH,
      messageInsert({
        id: 'm1',
        sessionId: 'ses_a',
        timeCreatedMs: 1_000,
        data: { role: 'user', time: { created: 1_000 } }
      })
    )
    expect(readOpenCodeNewestAssistant(db, ['ses_a']).has('ses_a')).toBe(false)
  })

  it('answers an empty map for no session ids, without querying', async () => {
    const { db } = await realDb()
    expect(readOpenCodeNewestAssistant(db, []).size).toBe(0)
  })

  it('answers an unknown schema with an empty map and no throw', async () => {
    const db = await unknownDb()
    expect(readOpenCodeNewestAssistant(db, ['ses_a']).size).toBe(0)
  })
})

describe('readOpenCodeMessages', () => {
  it('joins message x part, ordered by time_created then id', async () => {
    const { sqlite, db } = await realDb()
    sqlite.exec(REAL_PATH, sessionInsert({ id: 'ses_a', directory: '/home/j/p' }))
    sqlite.exec(
      REAL_PATH,
      messageInsert({
        id: 'm1',
        sessionId: 'ses_a',
        timeCreatedMs: 1_000,
        data: { role: 'user', time: { created: 1_000 } }
      })
    )
    sqlite.exec(
      REAL_PATH,
      partInsert({
        id: 'p1',
        messageId: 'm1',
        sessionId: 'ses_a',
        timeCreatedMs: 1_100,
        data: { type: 'text', text: 'What does this project do?' }
      })
    )
    sqlite.exec(
      REAL_PATH,
      messageInsert({
        id: 'm2',
        sessionId: 'ses_a',
        timeCreatedMs: 2_000,
        data: { role: 'assistant', time: { created: 2_000, completed: 2_500 }, finish: 'stop' }
      })
    )
    sqlite.exec(
      REAL_PATH,
      partInsert({
        id: 'p2',
        messageId: 'm2',
        sessionId: 'ses_a',
        timeCreatedMs: 2_100,
        data: { type: 'text', text: 'This repository is a floating panel.' }
      })
    )

    const { messages, parts } = readOpenCodeMessages(db, 'ses_a', 50)
    expect(messages.map((message) => message.id)).toEqual(['m1', 'm2'])
    expect(parts.map((part) => part.id)).toEqual(['p1', 'p2'])
  })

  it('answers an unknown schema with empty messages and parts, no throw', async () => {
    const db = await unknownDb()
    expect(readOpenCodeMessages(db, 'ses_a', 50)).toEqual({ messages: [], parts: [] })
  })

  it('answers a session with no messages with empty arrays, without a second query', async () => {
    const { db } = await realDb()
    expect(readOpenCodeMessages(db, 'ses_none', 50)).toEqual({ messages: [], parts: [] })
  })
})
