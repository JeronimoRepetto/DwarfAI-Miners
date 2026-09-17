import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FakeFs } from '../../adapters/fakeFs'
import type { FsLike } from '../../adapters/fsLike'
import { MemorySqlite } from '../../adapters/memorySqlite'
import type { SqliteDb, SqliteLike } from '../../adapters/sqliteLike'
import { dwarfSilenceWindowMs } from '../../domain/types'
import { OpenCodeProvider } from './opencodeProvider'
import {
  eventInsert,
  messageInsert,
  OPENCODE_SCHEMA,
  OPENCODE_UNKNOWN_SCHEMA,
  partInsert,
  sessionInsert
} from './stateSeed'

/*
 * Issue #444. `opencodeProvider.ts` is the store-reading provider D2/D3
 * describe: opencode.db read through FakeFs (stat only) + MemorySqlite, no
 * process probe, generation-swap on success only. This half covers scan()
 * discovery and D3 liveness; feed (3.7) and topology (3.9) follow appended.
 */

const ROOT = '/home/j/.local/share/opencode'
const DB_PATH = join(ROOT, 'opencode.db')
const WAL_PATH = join(ROOT, 'opencode.db-wal')
const NOW = new Date(2026, 8, 17, 12, 0, 0).getTime()

const FIXTURES = join(import.meta.dirname, '..', '__fixtures__', 'opencode')

/*
 * A minute after the row-4 fixtures' own `time_updated` (2025-09-15) — the
 * clock the measured-pair topology test runs against, since retention no
 * longer floors on the store-wide WAL mtime and the fixtures' timestamps are
 * a year stale against the default NOW (#444).
 */
const MEASUREMENT_NOW = 1_757_900_060_000 + 60_000

/** A row fixture (session-parent.json / session-child.json), as an INSERT-ready row. */
function sessionRowFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as Record<string, unknown>
}

/** One INSERT built straight from a captured session-row fixture, columns verbatim. */
function insertSessionFixture(sqlite: MemorySqlite, name: string): void {
  const row = sessionRowFixture(name)
  const columns = Object.keys(row)
  const values = columns.map((key) => {
    const value = row[key]
    if (value === null) return 'NULL'
    if (typeof value === 'number') return String(value)
    return `'${String(value).replaceAll("'", "''")}'`
  })
  sqlite.exec(DB_PATH, `INSERT INTO session (${columns.join(', ')}) VALUES (${values.join(', ')})`)
}

/** Registers a store that stats non-null; content length stands in for size. */
function seedStore(fake: FakeFs, dbBytes = 100, walBytes = 10): void {
  fake.addFile(DB_PATH, 'x'.repeat(dbBytes), NOW)
  fake.addFile(WAL_PATH, 'y'.repeat(walBytes), NOW)
}

function realSqlite(): MemorySqlite {
  const sqlite = new MemorySqlite()
  sqlite.define(DB_PATH, OPENCODE_SCHEMA)
  return sqlite
}

function unknownSqlite(): MemorySqlite {
  const sqlite = new MemorySqlite()
  sqlite.define(DB_PATH, OPENCODE_UNKNOWN_SCHEMA)
  return sqlite
}

/** Counts openReadOnly calls, so the size-gate's "zero calls" claim is provable. */
function countingSqlite(inner: SqliteLike): { sqlite: SqliteLike; calls: () => number } {
  let calls = 0
  return {
    sqlite: {
      async openReadOnly(path: string): Promise<SqliteDb | null> {
        calls++
        return inner.openReadOnly(path)
      }
    },
    calls: () => calls
  }
}

/** Delays fs.stat() until `gate.promise` resolves — deterministic mid-scan stability (#12). */
function gatedFs(inner: FsLike, gate: { promise: Promise<void> }): FsLike {
  return {
    stat: async (path) => {
      await gate.promise
      return inner.stat(path)
    },
    readTextTail: (path, n) => inner.readTextTail(path, n),
    readTextHead: (path, n) => inner.readTextHead(path, n),
    readJson: (path) => inner.readJson(path),
    listDir: (path) => inner.listDir(path),
    exists: (path) => inner.exists(path)
  }
}

function makeProvider(options: {
  fs: FsLike
  sqlite: SqliteLike
  now?: () => number
}): OpenCodeProvider {
  return new OpenCodeProvider({
    fs: options.fs,
    sqlite: options.sqlite,
    storeRoot: ROOT,
    now: options.now ?? (() => NOW)
  })
}

describe('OpenCodeProvider.scan — discovery', () => {
  it('appears within one scan', async () => {
    const fake = new FakeFs()
    seedStore(fake)
    const sqlite = realSqlite()
    sqlite.exec(DB_PATH, sessionInsert({ id: 'ses_a', directory: '/home/j/Sample-Project' }))
    sqlite.exec(
      DB_PATH,
      messageInsert({
        id: 'm1',
        sessionId: 'ses_a',
        timeCreatedMs: NOW - 1_000,
        data: { role: 'assistant', time: { created: NOW - 1_000 } }
      })
    )

    const provider = makeProvider({ fs: fake, sqlite })
    const [snapshot] = await provider.scan()
    expect(snapshot?.dwarfs.map((dwarf) => dwarf.id)).toEqual(['opencode:ses_a'])
  })

  it('returns no snapshots and does not throw when no store exists', async () => {
    const provider = makeProvider({ fs: new FakeFs(), sqlite: new MemorySqlite() })
    await expect(provider.scan()).resolves.toEqual([])
  })

  it('returns no snapshots and does not throw against an unknown schema', async () => {
    const fake = new FakeFs()
    seedStore(fake)
    const provider = makeProvider({ fs: fake, sqlite: unknownSqlite() })
    await expect(provider.scan()).resolves.toEqual([])
  })

  it('drops an empty-directory session rather than placing it (#166)', async () => {
    const fake = new FakeFs()
    seedStore(fake)
    const sqlite = realSqlite()
    sqlite.exec(DB_PATH, sessionInsert({ id: 'ses_phantom', directory: '' }))
    const provider = makeProvider({ fs: fake, sqlite })
    expect(await provider.scan()).toEqual([])
  })

  it('makes zero openReadOnly calls when both file sizes are unchanged', async () => {
    const fake = new FakeFs()
    seedStore(fake)
    const sqlite = realSqlite()
    // #444: fresh per-session fact — retention no longer floors on the store-wide WAL mtime.
    sqlite.exec(DB_PATH, sessionInsert({ id: 'ses_a', directory: '/home/j/p', timeUpdatedMs: NOW }))
    const { sqlite: counting, calls } = countingSqlite(sqlite)

    const provider = makeProvider({ fs: fake, sqlite: counting })
    await provider.scan()
    const firstCalls = calls()
    expect(firstCalls).toBeGreaterThan(0)

    const second = await provider.scan()
    expect(calls()).toBe(firstCalls) // no new call: sizes did not move
    expect(second.map((snapshot) => snapshot.sessionId)).toEqual(['ses_a'])
  })
})

describe('OpenCodeProvider.scan — D3 liveness', () => {
  it('is working while the newest assistant message lacks time.completed', async () => {
    const fake = new FakeFs()
    seedStore(fake)
    const sqlite = realSqlite()
    sqlite.exec(DB_PATH, sessionInsert({ id: 'ses_a', directory: '/home/j/p' }))
    sqlite.exec(
      DB_PATH,
      messageInsert({
        id: 'm1',
        sessionId: 'ses_a',
        timeCreatedMs: NOW - 1_000,
        data: { role: 'assistant', time: { created: NOW - 1_000 } }
      })
    )
    const [snapshot] = await makeProvider({ fs: fake, sqlite }).scan()
    expect(snapshot?.status).toBe('busy')
    expect(snapshot?.dwarfs[0]?.status).toBe('working')
  })

  it('is still working after a completed intermediate step (finish: tool-calls)', async () => {
    const fake = new FakeFs()
    seedStore(fake)
    const sqlite = realSqlite()
    sqlite.exec(DB_PATH, sessionInsert({ id: 'ses_a', directory: '/home/j/p' }))
    sqlite.exec(DB_PATH, eventInsert('e1', 'ses_a', 1))
    sqlite.exec(
      DB_PATH,
      messageInsert({
        id: 'm1',
        sessionId: 'ses_a',
        timeCreatedMs: NOW - 2_000,
        data: {
          role: 'assistant',
          time: { created: NOW - 2_000, completed: NOW - 1_000 },
          finish: 'tool-calls'
        }
      })
    )
    const [snapshot] = await makeProvider({ fs: fake, sqlite }).scan()
    expect(snapshot?.status).toBe('busy')
  })

  it('turns waiting once time.completed is set with finish: stop', async () => {
    const fake = new FakeFs()
    seedStore(fake)
    const sqlite = realSqlite()
    sqlite.exec(DB_PATH, sessionInsert({ id: 'ses_a', directory: '/home/j/p' }))
    sqlite.exec(
      DB_PATH,
      messageInsert({
        id: 'm1',
        sessionId: 'ses_a',
        timeCreatedMs: NOW - 2_000,
        data: {
          role: 'assistant',
          time: { created: NOW - 2_000, completed: NOW - 1_000 },
          finish: 'stop'
        }
      })
    )
    const [snapshot] = await makeProvider({ fs: fake, sqlite }).scan()
    expect(snapshot?.status).toBe('idle')
    expect(snapshot?.dwarfs[0]?.status).toBe('waiting')
  })

  it('is working when only event.seq advanced since the previous poll', async () => {
    const fake = new FakeFs()
    seedStore(fake, 100, 10)
    const sqlite = realSqlite()
    sqlite.exec(DB_PATH, sessionInsert({ id: 'ses_a', directory: '/home/j/p' }))
    sqlite.exec(
      DB_PATH,
      messageInsert({
        id: 'm1',
        sessionId: 'ses_a',
        timeCreatedMs: NOW - 5_000,
        data: {
          role: 'assistant',
          time: { created: NOW - 5_000, completed: NOW - 4_000 },
          finish: 'stop'
        }
      })
    )
    sqlite.exec(DB_PATH, eventInsert('e1', 'ses_a', 1))

    const provider = makeProvider({ fs: fake, sqlite })
    const [first] = await provider.scan()
    expect(first?.status).toBe('idle') // settled turn, nothing else has happened yet

    // A new turn starts: the store grows (new wal bytes) and seq advances,
    // well before any new assistant row has been written.
    fake.addFile(DB_PATH, 'x'.repeat(100), NOW)
    fake.addFile(WAL_PATH, 'y'.repeat(40), NOW)
    sqlite.exec(DB_PATH, eventInsert('e2', 'ses_a', 2))
    const [second] = await provider.scan()
    expect(second?.status).toBe('busy')
  })

  it('never reports SessionStatus waiting — only busy or idle', async () => {
    const fake = new FakeFs()
    seedStore(fake)
    const sqlite = realSqlite()
    // #444: fresh per-session fact — retention no longer floors on the store-wide WAL mtime.
    sqlite.exec(DB_PATH, sessionInsert({ id: 'ses_a', directory: '/home/j/p', timeUpdatedMs: NOW }))
    const [snapshot] = await makeProvider({ fs: fake, sqlite }).scan()
    expect(['busy', 'idle']).toContain(snapshot?.status)
  })

  it('settles a stuck streaming (tool-calls) row to waiting after BUSY_WINDOW_MS with no seq advance', async () => {
    const fake = new FakeFs()
    seedStore(fake, 100, 10)
    const sqlite = realSqlite()
    sqlite.exec(DB_PATH, sessionInsert({ id: 'ses_a', directory: '/home/j/p' }))
    sqlite.exec(DB_PATH, eventInsert('e1', 'ses_a', 1))
    sqlite.exec(
      DB_PATH,
      messageInsert({
        id: 'm1',
        sessionId: 'ses_a',
        timeCreatedMs: NOW - 5_000,
        data: {
          role: 'assistant',
          time: { created: NOW - 5_000, completed: NOW - 4_000 },
          finish: 'tool-calls'
        }
      })
    )

    let clock = NOW
    const provider = makeProvider({ fs: fake, sqlite, now: () => clock })
    const [first] = await provider.scan()
    expect(first?.status).toBe('busy') // an intermediate step, not yet stalled

    // No new event, no new message — the store must still register as
    // "grown" for a scan to even re-read it, so bump the wal bytes without
    // moving seq, then let more than BUSY_WINDOW_MS elapse.
    fake.addFile(WAL_PATH, 'y'.repeat(20), NOW)
    clock += 130_000
    const [second] = await provider.scan()
    expect(second?.status).toBe('idle')
  })
})

describe('OpenCodeProvider.scan — retention', () => {
  it('keeps a root (foreman) dwarf past the short window, up to the long one', async () => {
    const fake = new FakeFs()
    seedStore(fake)
    const sqlite = realSqlite()
    sqlite.exec(
      DB_PATH,
      sessionInsert({ id: 'ses_root', directory: '/home/j/p', timeUpdatedMs: NOW })
    )
    let clock = NOW
    const provider = makeProvider({ fs: fake, sqlite, now: () => clock })
    await provider.scan()

    const shortWindowMs = dwarfSilenceWindowMs('worker', 'unknown')
    const longWindowMs = dwarfSilenceWindowMs('foreman', 'unknown')
    expect(longWindowMs).toBeGreaterThan(shortWindowMs)

    clock = NOW + shortWindowMs + 1_000
    fake.addFile(DB_PATH, 'x'.repeat(101), NOW)
    const stillThere = await provider.scan()
    expect(stillThere.map((snapshot) => snapshot.sessionId)).toEqual(['ses_root'])

    clock = NOW + longWindowMs + 1_000
    fake.addFile(DB_PATH, 'x'.repeat(102), NOW)
    expect(await provider.scan()).toEqual([])
  })

  it('drops a worker (parent_id set) past the short window', async () => {
    const fake = new FakeFs()
    seedStore(fake)
    const sqlite = realSqlite()
    // #444: fresh per-session fact — retention no longer floors on the store-wide WAL mtime.
    sqlite.exec(DB_PATH, sessionInsert({ id: 'ses_parent', directory: '/home/j/p', timeUpdatedMs: NOW }))
    sqlite.exec(
      DB_PATH,
      sessionInsert({
        id: 'ses_child',
        directory: '/home/j/p',
        parentId: 'ses_parent',
        timeUpdatedMs: NOW
      })
    )
    let clock = NOW
    const provider = makeProvider({ fs: fake, sqlite, now: () => clock })
    await provider.scan()

    const shortWindowMs = dwarfSilenceWindowMs('worker', 'unknown')
    clock = NOW + shortWindowMs + 1_000
    fake.addFile(DB_PATH, 'x'.repeat(101), NOW)
    const ids = (await provider.scan()).flatMap((snapshot) => snapshot.dwarfs.map((d) => d.id))
    expect(ids).not.toContain('opencode:ses_child')
  })

  it('drops a frozen session even while another session keeps the store WAL hot', async () => {
    const fake = new FakeFs()
    seedStore(fake)
    const sqlite = realSqlite()
    const settledTurn = {
      role: 'assistant',
      time: { created: NOW - 5_000, completed: NOW - 4_000 },
      finish: 'stop'
    }
    sqlite.exec(
      DB_PATH,
      sessionInsert({
        id: 'ses_frozen',
        directory: '/home/j/p',
        timeCreatedMs: NOW - 5_000,
        timeUpdatedMs: NOW
      })
    )
    sqlite.exec(
      DB_PATH,
      messageInsert({
        id: 'm1',
        sessionId: 'ses_frozen',
        timeCreatedMs: NOW - 5_000,
        data: settledTurn
      })
    )
    sqlite.exec(
      DB_PATH,
      sessionInsert({
        id: 'ses_active',
        directory: '/home/j/p',
        timeCreatedMs: NOW - 5_000,
        timeUpdatedMs: NOW
      })
    )
    sqlite.exec(
      DB_PATH,
      messageInsert({
        id: 'm2',
        sessionId: 'ses_active',
        timeCreatedMs: NOW - 5_000,
        data: settledTurn
      })
    )

    let clock = NOW
    const provider = makeProvider({ fs: fake, sqlite, now: () => clock })
    const first = await provider.scan()
    expect(first.map((snapshot) => snapshot.sessionId).sort()).toEqual(['ses_active', 'ses_frozen'])

    // Both are roots, so the long window governs. Advance past it: the
    // active session's own row moves at the new now while every fact of the
    // frozen one stands still — and the store-wide WAL's mtime is stamped at
    // the new now, the write any session makes that must not count as the
    // frozen session's own activity (#444).
    clock = NOW + dwarfSilenceWindowMs('foreman', 'unknown') + 1_000
    sqlite.exec(DB_PATH, `UPDATE session SET time_updated = ${clock} WHERE id = 'ses_active'`)
    fake.addFile(DB_PATH, 'x'.repeat(101), NOW)
    fake.addFile(WAL_PATH, 'y'.repeat(20), clock)

    const ids = (await provider.scan()).map((snapshot) => snapshot.sessionId)
    expect(ids).toEqual(['ses_active'])
  })
})

describe('OpenCodeProvider.scan — mid-scan stability (#12)', () => {
  it('a click mid-scan sees the previous generation, never a half-built one', async () => {
    const fake = new FakeFs()
    seedStore(fake)
    const sqlite = realSqlite()
    // #444: fresh per-session fact — retention no longer floors on the store-wide WAL mtime.
    sqlite.exec(DB_PATH, sessionInsert({ id: 'ses_a', directory: '/home/j/p', timeUpdatedMs: NOW }))

    const gate = { promise: Promise.resolve() }
    const provider = makeProvider({ fs: gatedFs(fake, gate), sqlite })
    const [first] = await provider.scan()
    expect(first?.sessionId).toBe('ses_a')

    let release: () => void = () => undefined
    gate.promise = new Promise((resolve) => {
      release = resolve
    })
    fake.addFile(DB_PATH, 'x'.repeat(101), NOW) // force the next scan to actually read
    const scanning = provider.scan()
    // The gated stat() has not resolved yet, so scan() cannot have swapped its
    // generation — a concurrent call must still see the one just published.
    expect((await provider.feed('opencode:ses_a', 5)) !== null).toBe(true)
    release()
    await scanning
  })
})

/*
 * Feed half (#444, opencode-session-feed). No file backs the feed: rows are
 * assembled fresh from `state.ts` on every call, redacted at this boundary,
 * with `feedPage` composing the exported `cursorIndex` (`feedWindow.ts`)
 * directly since there is no byte window to walk.
 */
describe('OpenCodeProvider — feed', () => {
  function seededSession(): { fake: FakeFs; sqlite: MemorySqlite } {
    const fake = new FakeFs()
    seedStore(fake)
    const sqlite = realSqlite()
    // #444: fresh per-session fact — retention no longer floors on the store-wide WAL mtime.
    sqlite.exec(DB_PATH, sessionInsert({ id: 'ses_a', directory: '/home/j/p', timeUpdatedMs: NOW }))
    return { fake, sqlite }
  }

  it('carries the newest assistant text as lastMessage, absent when none exists', async () => {
    const { fake, sqlite } = seededSession()
    sqlite.exec(
      DB_PATH,
      messageInsert({
        id: 'm1',
        sessionId: 'ses_a',
        timeCreatedMs: NOW - 2_000,
        data: { role: 'user', time: { created: NOW - 2_000 } }
      })
    )
    const noReplyYet = await makeProvider({ fs: fake, sqlite }).scan()
    expect(noReplyYet[0]?.dwarfs[0]?.lastMessage).toBeUndefined()

    sqlite.exec(
      DB_PATH,
      messageInsert({
        id: 'm2',
        sessionId: 'ses_a',
        timeCreatedMs: NOW - 1_000,
        data: {
          role: 'assistant',
          time: { created: NOW - 1_000, completed: NOW - 500 },
          finish: 'stop'
        }
      })
    )
    sqlite.exec(
      DB_PATH,
      partInsert({
        id: 'p1',
        messageId: 'm2',
        sessionId: 'ses_a',
        timeCreatedMs: NOW - 900,
        data: { type: 'text', text: 'This repository is a floating dwarf panel.' }
      })
    )
    fake.addFile(DB_PATH, 'x'.repeat(101), NOW)
    const [withReply] = await makeProvider({ fs: fake, sqlite }).scan()
    expect(withReply?.dwarfs[0]?.lastMessage).toBe('This repository is a floating dwarf panel.')
  })

  it('returns null from feed and feedPage for an id the latest scan does not know', async () => {
    const { fake, sqlite } = seededSession()
    const provider = makeProvider({ fs: fake, sqlite })
    await provider.scan()
    expect(await provider.feed('opencode:never-seen', 5)).toBeNull()
    expect(
      await provider.feedPage('opencode:never-seen', 5, { timestamp: '', text: 'x' })
    ).toBeNull()
  })

  it('redacts a secret in a feed row, and a cursor built from the redacted row still matches', async () => {
    const { fake, sqlite } = seededSession()
    sqlite.exec(
      DB_PATH,
      messageInsert({
        id: 'm1',
        sessionId: 'ses_a',
        timeCreatedMs: NOW - 3_000,
        data: { role: 'user', time: { created: NOW - 3_000 } }
      })
    )
    sqlite.exec(
      DB_PATH,
      partInsert({
        id: 'p1',
        messageId: 'm1',
        sessionId: 'ses_a',
        timeCreatedMs: NOW - 2_900,
        data: { type: 'text', text: 'sk-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN' }
      })
    )
    sqlite.exec(
      DB_PATH,
      messageInsert({
        id: 'm2',
        sessionId: 'ses_a',
        timeCreatedMs: NOW - 1_000,
        data: {
          role: 'assistant',
          time: { created: NOW - 1_000, completed: NOW - 500 },
          finish: 'stop'
        }
      })
    )
    sqlite.exec(
      DB_PATH,
      partInsert({
        id: 'p2',
        messageId: 'm2',
        sessionId: 'ses_a',
        timeCreatedMs: NOW - 900,
        data: { type: 'text', text: 'Got it.' }
      })
    )

    const provider = makeProvider({ fs: fake, sqlite })
    await provider.scan()
    const feed = await provider.feed('opencode:ses_a', 5)
    expect(feed?.[0]?.text).not.toContain('sk-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN')
    expect(feed?.[0]?.text).toContain('[redacted]')

    const cursor = { timestamp: feed![1]!.timestamp, text: feed![1]!.text }
    const page = await provider.feedPage('opencode:ses_a', 5, cursor)
    expect(page?.messages.map((message) => message.text)).toEqual([feed![0]!.text])
    expect(page?.reachedStart).toBe(true)
  })

  it('drops an unparseable part.data row from the feed without dropping the session', async () => {
    const { fake, sqlite } = seededSession()
    sqlite.exec(
      DB_PATH,
      messageInsert({
        id: 'm1',
        sessionId: 'ses_a',
        timeCreatedMs: NOW - 1_000,
        data: { role: 'user', time: { created: NOW - 1_000 } }
      })
    )
    // A part row whose data is not valid JSON at all.
    sqlite.exec(
      DB_PATH,
      `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('p1', 'm1', 'ses_a', ${NOW - 900}, ${NOW - 900}, 'not json')`
    )
    const provider = makeProvider({ fs: fake, sqlite })
    const [snapshot] = await provider.scan()
    expect(snapshot?.sessionId).toBe('ses_a') // the session still publishes
    expect(await provider.feed('opencode:ses_a', 5)).toEqual([])
  })

  it('answers feed [] and feedPage an empty reachedStart page when the store vanished after the scan', async () => {
    const { fake, sqlite } = seededSession()
    const provider = makeProvider({ fs: fake, sqlite })
    await provider.scan()
    sqlite.remove(DB_PATH)
    expect(await provider.feed('opencode:ses_a', 5)).toEqual([])
    expect(await provider.feedPage('opencode:ses_a', 5, { timestamp: '', text: 'x' })).toEqual({
      messages: [],
      reachedStart: true
    })
  })

  it('never returns a transcriptPath and never offers a delivery channel', async () => {
    const { fake, sqlite } = seededSession()
    const provider = makeProvider({ fs: fake, sqlite })
    await provider.scan()
    expect(provider.transcriptPath('opencode:ses_a')).toBeUndefined()
    expect(provider.textDelivery?.('opencode:ses_a')).toBeNull()
  })
})

/*
 * Topology half (#444, D4, opencode-session-topology). `session.parent_id` is
 * the only source; `message.data.parentID` is never read as an edge (proven
 * at the parse.ts layer already — these fixtures do not even carry one at
 * the session level, since it is a message-level fact).
 */
describe('OpenCodeProvider — topology (D4)', () => {
  it('ranks a child below the root and promotes the parent to foreman — the measured row-4 pair', async () => {
    const fake = new FakeFs()
    seedStore(fake)
    const sqlite = realSqlite()
    insertSessionFixture(sqlite, 'session-parent.json')
    insertSessionFixture(sqlite, 'session-child.json')

    const dwarfs = (
      await makeProvider({ fs: fake, sqlite, now: () => MEASUREMENT_NOW }).scan()
    ).flatMap((s) => s.dwarfs)
    const child = dwarfs.find((dwarf) => dwarf.id === 'opencode:ses_placeholder_child')
    const foreman = dwarfs.find((dwarf) => dwarf.id === 'opencode:ses_placeholder_parent')
    expect(child?.role).toBe('worker')
    expect(child?.parentId).toBe('opencode:ses_placeholder_parent')
    expect(foreman?.role).toBe('foreman')
  })

  it('publishes a child whose parent is absent from the store, inventing no parent', async () => {
    const fake = new FakeFs()
    seedStore(fake)
    const sqlite = realSqlite()
    // #444: fresh per-session fact — retention no longer floors on the store-wide WAL mtime.
    sqlite.exec(
      DB_PATH,
      sessionInsert({
        id: 'ses_orphan',
        directory: '/home/j/p',
        parentId: 'ses_nowhere',
        timeUpdatedMs: NOW
      })
    )
    const [snapshot] = await makeProvider({ fs: fake, sqlite }).scan()
    expect(snapshot?.dwarfs[0]?.id).toBe('opencode:ses_orphan')
    expect(snapshot?.dwarfs[0]?.parentId).toBe('opencode:ses_nowhere')
    expect(
      (await makeProvider({ fs: fake, sqlite }).scan()).some((s) => s.sessionId === 'ses_nowhere')
    ).toBe(false)
  })

  it('publishes a null parent_id session as a root foreman', async () => {
    const fake = new FakeFs()
    seedStore(fake)
    const sqlite = realSqlite()
    // #444: fresh per-session fact — retention no longer floors on the store-wide WAL mtime.
    sqlite.exec(DB_PATH, sessionInsert({ id: 'ses_root', directory: '/home/j/p', timeUpdatedMs: NOW }))
    const [snapshot] = await makeProvider({ fs: fake, sqlite }).scan()
    expect(snapshot?.dwarfs[0]?.role).toBe('foreman')
    expect(snapshot?.dwarfs[0]?.parentId).toBeUndefined()
  })

  it('keeps a foreman rank after its crew has gone home', async () => {
    const fake = new FakeFs()
    seedStore(fake)
    const sqlite = realSqlite()
    // #444: fresh per-session facts — retention no longer floors on the store-wide WAL mtime.
    sqlite.exec(DB_PATH, sessionInsert({ id: 'ses_parent', directory: '/home/j/p', timeUpdatedMs: NOW }))
    sqlite.exec(
      DB_PATH,
      sessionInsert({
        id: 'ses_child',
        directory: '/home/j/p',
        parentId: 'ses_parent',
        timeUpdatedMs: NOW
      })
    )
    const provider = makeProvider({ fs: fake, sqlite })
    const first = (await provider.scan()).flatMap((s) => s.dwarfs)
    expect(first.find((d) => d.id === 'opencode:ses_parent')?.role).toBe('foreman')

    // The crew is gone: the child's row is deleted from the store.
    sqlite.exec(DB_PATH, "DELETE FROM session WHERE id = 'ses_child'")
    fake.addFile(DB_PATH, 'x'.repeat(101), NOW)
    const second = (await provider.scan()).flatMap((s) => s.dwarfs)
    expect(second.map((d) => d.id)).toEqual(['opencode:ses_parent'])
    expect(second[0]?.role).toBe('foreman')
  })
})
