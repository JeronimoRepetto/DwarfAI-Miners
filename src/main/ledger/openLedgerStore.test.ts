import { describe, expect, it, vi } from 'vitest'
import { MemoryWritableSqlite } from '../adapters/memoryWritableSqlite'
import { createAppDatabase } from '../appDatabase/appDatabase'
import { mineTotals, serializeLedger, creditMaterial, emptyLedger } from '../domain/ledger'
import type { LedgerFsLike } from './ledgerStore'
import { openLedgerStore } from './openLedgerStore'

const DB = 'C:\\userData\\projects-v1.db'
const JSON_PATH = 'C:\\userData\\material-ledger-v1.json'

/** A vault holding one mine's gold, in the document shape the app writes. */
const DOCUMENT = serializeLedger(creditMaterial(emptyLedger(), 'mine:forge', 'gold', 6_000))

/**
 * Deterministic fake carrying the FULL read/write surface the JSON store has,
 * so a test can prove nothing wrote to the document — a read-only fake would
 * prove only that this fake has no write method.
 */
function fakeFs(seed: Record<string, string> = {}): LedgerFsLike & {
  files: Map<string, string>
  writes: string[]
} {
  const files = new Map(Object.entries(seed))
  const writes: string[] = []
  return {
    files,
    writes,
    async readFile(path) {
      const content = files.get(path)
      if (content === undefined) throw new Error(`ENOENT ${path}`)
      return content
    },
    async writeFile(path, data) {
      writes.push(path)
      files.set(path, data)
    },
    async rename(from, to) {
      const content = files.get(from)
      if (content === undefined) throw new Error(`ENOENT ${from}`)
      files.delete(from)
      files.set(to, content)
    }
  }
}

function open(options: {
  sqlite: MemoryWritableSqlite
  fs: LedgerFsLike
  warn?: (message: string) => void
  log?: (message: string) => void
}) {
  return openLedgerStore({
    database: createAppDatabase({ filePath: DB, sqlite: options.sqlite }),
    fs: options.fs,
    jsonPath: JSON_PATH,
    now: () => 1_700_000_100_000,
    warn: options.warn,
    log: options.log
  })
}

describe('openLedgerStore — the first boot after the upgrade', () => {
  it('migrates the document and hands back the database-backed vault', async () => {
    const sqlite = new MemoryWritableSqlite()
    const fs = fakeFs({ [JSON_PATH]: DOCUMENT })

    const opened = await open({ sqlite, fs })

    expect(opened.backing).toBe('database')
    expect(opened.migration).toMatchObject({ status: 'migrated', mines: 1 })
    expect(mineTotals(await opened.store.load(), 'mine:forge').gold).toBe(6_000)
  })

  it('leaves the document byte-for-byte where it found it', async () => {
    // It is the only backup of a history that costs a full transcript rescan to
    // reproduce. Nothing in this path may write, rename or unlink it — ever.
    const sqlite = new MemoryWritableSqlite()
    const fs = fakeFs({ [JSON_PATH]: DOCUMENT })

    await open({ sqlite, fs })

    expect(fs.writes).toEqual([])
    expect(fs.files.get(JSON_PATH)).toBe(DOCUMENT)
    expect([...fs.files.keys()]).toEqual([JSON_PATH])
  })

  it('says once, in the log, where the vault came from', async () => {
    const log = vi.fn()

    await open({ sqlite: new MemoryWritableSqlite(), fs: fakeFs({ [JSON_PATH]: DOCUMENT }), log })

    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0]![0]).toContain('migrated')
  })
})

describe('openLedgerStore — an ordinary boot afterwards', () => {
  it('ignores the document entirely once the marker is there', async () => {
    const sqlite = new MemoryWritableSqlite()
    const fs = fakeFs({ [JSON_PATH]: DOCUMENT })
    const first = await open({ sqlite, fs })
    // Ore mined after the migration, which the stale document knows nothing of.
    await first.store.save(creditMaterial(await first.store.load(), 'mine:forge', 'gold', 1_000))

    const second = await open({ sqlite, fs })

    expect(second.backing).toBe('database')
    expect(second.migration).toMatchObject({ status: 'already-migrated' })
    expect(mineTotals(await second.store.load(), 'mine:forge').gold).toBe(7_000)
  })

  it('does not read the document at all', async () => {
    const sqlite = new MemoryWritableSqlite()
    const fs = fakeFs({ [JSON_PATH]: DOCUMENT })
    await open({ sqlite, fs })
    const readFile = vi.spyOn(fs, 'readFile')

    await open({ sqlite, fs })

    expect(readFile).not.toHaveBeenCalled()
  })
})

describe('openLedgerStore — a fresh install with no document', () => {
  it('takes the database and records that there was nothing to carry across', async () => {
    const opened = await open({ sqlite: new MemoryWritableSqlite(), fs: fakeFs() })

    expect(opened.backing).toBe('database')
    expect(opened.migration).toMatchObject({ status: 'no-source', mines: 0, sessions: 0 })
  })
})

describe('openLedgerStore — a migration that could not be written', () => {
  /** A v2 database whose session_marks table is gone, so the write fails. */
  async function brokenTable(sqlite: MemoryWritableSqlite): Promise<void> {
    const db = await createAppDatabase({ filePath: DB, sqlite }).connect()
    db.exec('DROP TABLE session_marks')
  }

  it('falls back to the document for this run, because it is still the current copy', async () => {
    // No marker was written, so nothing has taken over from the document and
    // trusting it costs nothing. The next boot simply tries the migration again.
    const sqlite = new MemoryWritableSqlite()
    await brokenTable(sqlite)
    const fs = fakeFs({ [JSON_PATH]: DOCUMENT })

    const opened = await open({ sqlite, fs })

    expect(opened.backing).toBe('json')
    expect(mineTotals(await opened.store.load(), 'mine:forge').gold).toBe(6_000)
  })

  it('states the reason exactly once', async () => {
    const sqlite = new MemoryWritableSqlite()
    await brokenTable(sqlite)
    const warn = vi.fn()

    await open({ sqlite, fs: fakeFs({ [JSON_PATH]: DOCUMENT }), warn })

    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('material-ledger-v1.json')
  })
})

describe('openLedgerStore — a database that will not open', () => {
  it('keeps the document when the runtime has no sqlite driver at all', async () => {
    // 'unavailable' is the one refusal that proves the database never took over:
    // a runtime with no node:sqlite could not have written the marker on any
    // earlier launch of this build either.
    const sqlite = new MemoryWritableSqlite()
    sqlite.failWith('unavailable')

    const opened = await open({ sqlite, fs: fakeFs({ [JSON_PATH]: DOCUMENT }) })

    expect(opened.backing).toBe('json')
    expect(mineTotals(await opened.store.load(), 'mine:forge').gold).toBe(6_000)
  })

  it('keeps the document when the file is stamped below the version the vault moved in', async () => {
    // A database still at v1 has never held a materials table, so the document
    // is provably the current copy even though the upgrade to v2 failed.
    const sqlite = new MemoryWritableSqlite()
    const seeded = await sqlite.open(DB)
    seeded.exec('PRAGMA user_version = 1')
    // session_marks standing in the way makes the v1 -> v2 upgrade fail.
    seeded.exec('CREATE TABLE session_marks (nonsense TEXT)')
    seeded.close()

    const opened = await open({ sqlite, fs: fakeFs({ [JSON_PATH]: DOCUMENT }) })

    expect(opened.backing).toBe('json')
    expect(mineTotals(await opened.store.load(), 'mine:forge').gold).toBe(6_000)
  })

  it('remembers nothing this run when it cannot prove the document is current', async () => {
    // The hard case. A corrupt v2 database may already hold everything the
    // document does not, and its session marks with it. Reviving the document
    // would make the next poll re-credit every delta accrued since the
    // migration, permanently. So this run accrues in memory, persists nothing,
    // and leaves both files exactly as they are.
    const sqlite = new MemoryWritableSqlite()
    sqlite.failWith('corrupt')
    const fs = fakeFs({ [JSON_PATH]: DOCUMENT })

    const opened = await open({ sqlite, fs })

    expect(opened.backing).toBe('memory')
    expect(await opened.store.load()).toEqual(emptyLedger())
    await opened.store.save(creditMaterial(emptyLedger(), 'mine:forge', 'gold', 5))
    expect(fs.writes).toEqual([])
    expect(fs.files.get(JSON_PATH)).toBe(DOCUMENT)
  })

  it('refuses a schema from the future rather than reviving a stale document', async () => {
    // A downgraded app. The v3 file certainly held the vault, so the document is
    // certainly stale.
    const sqlite = new MemoryWritableSqlite()
    const seeded = await sqlite.open(DB)
    seeded.exec('PRAGMA user_version = 3')
    seeded.close()

    const opened = await open({ sqlite, fs: fakeFs({ [JSON_PATH]: DOCUMENT }) })

    expect(opened.backing).toBe('memory')
  })

  it('says out loud that this session will not be remembered', async () => {
    const sqlite = new MemoryWritableSqlite()
    sqlite.failWith('corrupt')
    const warn = vi.fn()

    await open({ sqlite, fs: fakeFs({ [JSON_PATH]: DOCUMENT }), warn })

    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('corrupt')
  })
})

describe('openLedgerStore — a vault the database cannot be read back from', () => {
  it('remembers nothing this run rather than reporting a mined history as gone', async () => {
    // The marker says the database took over, and then the read fails. Same
    // reasoning as a corrupt file, arriving one step later.
    const sqlite = new MemoryWritableSqlite()
    const fs = fakeFs({ [JSON_PATH]: DOCUMENT })
    await open({ sqlite, fs })
    const db = await createAppDatabase({ filePath: DB, sqlite }).connect()
    db.exec('DROP TABLE materials')

    const opened = await open({ sqlite, fs })

    expect(opened.backing).toBe('memory')
    expect(fs.writes).toEqual([])
  })
})
