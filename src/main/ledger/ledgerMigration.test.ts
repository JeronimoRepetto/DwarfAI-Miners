import { describe, expect, it, vi } from 'vitest'
import { MemoryWritableSqlite } from '../adapters/memoryWritableSqlite'
import { createAppDatabase } from '../appDatabase/appDatabase'
import { mineTotals } from '../domain/ledger'
import { LEDGER_MIGRATION_KEY, createSqliteLedgerStore } from './sqliteLedgerStore'
import { migrateLedgerJson } from './ledgerMigration'

const DB = 'C:\\userData\\projects-v1.db'
const JSON_PATH = 'C:\\userData\\material-ledger-v1.json'

/**
 * A synthetic ledger document in the exact shape the app writes: two mines
 * holding two different materials, and two session marks.
 *
 * Every id, path and session key here is invented (see privacy-guard). The
 * numbers are round on purpose — the point of a golden fixture is that the
 * expected rows can be read off it, not that it resembles anybody's history.
 */
const DOCUMENT = JSON.stringify({
  version: 1,
  mines: {
    'mine:forge': { bronze: 0, copper: 400, silver: 0, gold: 0, uranium: 0, coal: 1_200 },
    'mine:smelter': { bronze: 0, copper: 0, silver: 900, gold: 0, uranium: 0, coal: 0 }
  },
  sessions: {
    'claude:s1': { tokens: 4_000, seenAt: 1_700_000_000_000 },
    'codex:s2': { tokens: 2_500, seenAt: 1_700_000_050_000 }
  }
})

function fixture(document: string | null = DOCUMENT): {
  sqlite: MemoryWritableSqlite
  readJson: ReturnType<typeof vi.fn>
  run: () => ReturnType<typeof migrateLedgerJson>
} {
  const sqlite = new MemoryWritableSqlite()
  const readJson = vi.fn(async (path: string) => {
    if (document === null) throw new Error(`ENOENT ${path}`)
    return document
  })
  return {
    sqlite,
    readJson,
    run: () =>
      migrateLedgerJson({
        database: createAppDatabase({ filePath: DB, sqlite }),
        readJson,
        jsonPath: JSON_PATH,
        now: () => 1_700_000_100_000
      })
  }
}

describe('ledger migration — the first boot that finds the document', () => {
  it('writes exactly the rows the document describes', async () => {
    const { sqlite, run } = fixture()

    const outcome = await run()

    expect(outcome).toMatchObject({ status: 'migrated', mines: 2, sessions: 2 })
    const db = await sqlite.open(DB)
    expect(
      db.all('SELECT mine_id, material, tokens FROM materials ORDER BY mine_id, material')
    ).toEqual([
      { mine_id: 'mine:forge', material: 'coal', tokens: 1_200 },
      { mine_id: 'mine:forge', material: 'copper', tokens: 400 },
      { mine_id: 'mine:smelter', material: 'silver', tokens: 900 }
    ])
    expect(db.all('SELECT key, tokens, seen_at FROM session_marks ORDER BY key')).toEqual([
      { key: 'claude:s1', tokens: 4_000, seen_at: 1_700_000_000_000 },
      { key: 'codex:s2', tokens: 2_500, seen_at: 1_700_000_050_000 }
    ])
  })

  it('records what it did, so the next boot needs no guesswork', async () => {
    const { sqlite, run } = fixture()

    await run()

    const db = await sqlite.open(DB)
    expect(db.all('SELECT * FROM ledger_meta')).toEqual([
      {
        key: LEDGER_MIGRATION_KEY,
        migrated_at: 1_700_000_100_000,
        source: JSON_PATH,
        mines: 2,
        sessions: 2
      }
    ])
  })

  it('hands the vault to the store the panel will read from', async () => {
    // The migration is only worth anything if the ordinary reader sees it.
    const { sqlite, run } = fixture()

    await run()

    const restored = await createSqliteLedgerStore({
      database: createAppDatabase({ filePath: DB, sqlite })
    }).load()
    expect(mineTotals(restored, 'mine:forge').coal).toBe(1_200)
    expect(restored.sessions['codex:s2']).toEqual({ tokens: 2_500, seenAt: 1_700_000_050_000 })
  })

  it('reads the document through the existing codec, tolerance rules and all', async () => {
    // parseLedger's rules ARE the contract: an unknown key is ignored, an
    // unusable count reads as zero, and a mark missing half of itself is
    // dropped. A migration with its own parser would be a second contract.
    const { sqlite, run } = fixture(
      JSON.stringify({
        version: 1,
        mines: { 'mine:odd': { gold: 700, mithril: 999, silver: 'lots' } },
        sessions: { 'claude:half': { tokens: 10 }, 'claude:whole': { tokens: 20, seenAt: 5 } }
      })
    )

    const outcome = await run()

    const db = await sqlite.open(DB)
    expect(db.all('SELECT material, tokens FROM materials')).toEqual([
      { material: 'gold', tokens: 700 }
    ])
    expect(db.all('SELECT key FROM session_marks')).toEqual([{ key: 'claude:whole' }])
    expect(outcome).toMatchObject({ status: 'migrated', mines: 1, sessions: 1 })
  })
})

describe('ledger migration — every boot after it', () => {
  it('migrates nothing a second time, and does not even open the document', async () => {
    const { sqlite, readJson, run } = fixture()
    await run()
    readJson.mockClear()

    const outcome = await run()

    expect(outcome.status).toBe('already-migrated')
    expect(readJson).not.toHaveBeenCalled()
    const db = await sqlite.open(DB)
    expect(db.all('SELECT count(*) AS n FROM ledger_meta')).toEqual([{ n: 1 }])
  })

  it('reports the counts the first run recorded, not a fresh reading', async () => {
    const { run } = fixture()
    await run()

    expect(await run()).toMatchObject({ status: 'already-migrated', mines: 2, sessions: 2 })
  })

  it('leaves ore accrued since the migration alone', async () => {
    // The marker, not the row count, is what makes the document ignorable. A
    // second run that rewrote the tables from the stale document would throw
    // away everything mined since.
    const { sqlite, run } = fixture()
    await run()
    const database = createAppDatabase({ filePath: DB, sqlite })
    const db = await database.connect()
    db.run('UPDATE materials SET tokens = ? WHERE mine_id = ?', [5_000, 'mine:forge'])

    await run()

    expect(
      db.all('SELECT tokens FROM materials WHERE mine_id = ? AND material = ?', [
        'mine:forge',
        'coal'
      ])
    ).toEqual([{ tokens: 5_000 }])
  })
})

describe('ledger migration — a document that is not there', () => {
  it('still records a marker, so a restored backup can never be replayed', async () => {
    // A stale material-ledger-v1.json dropped back in later carries session
    // marks whose baselines the database has long since passed. Migrating it
    // would credit every delta since a second time.
    const { sqlite, run } = fixture(null)

    const outcome = await run()

    expect(outcome).toMatchObject({ status: 'no-source', mines: 0, sessions: 0 })
    const db = await sqlite.open(DB)
    expect(db.all('SELECT mines, sessions FROM ledger_meta')).toEqual([{ mines: 0, sessions: 0 }])
  })

  it('reads a document it cannot parse as an empty vault, exactly as today', async () => {
    // parseLedger already turns a corrupt document into an empty ledger, and a
    // migration is not the place to invent a different answer.
    const { sqlite, run } = fixture('{ truncated')

    const outcome = await run()

    expect(outcome).toMatchObject({ status: 'migrated', mines: 0, sessions: 0 })
    const db = await sqlite.open(DB)
    expect(db.all('SELECT mine_id FROM materials')).toEqual([])
    expect(db.all('SELECT count(*) AS n FROM ledger_meta')).toEqual([{ n: 1 }])
  })
})

describe('ledger migration — a write that cannot finish', () => {
  it('records no marker, so the next boot tries again', async () => {
    const { sqlite, run } = fixture()
    const db = await createAppDatabase({ filePath: DB, sqlite }).connect()
    db.exec('DROP TABLE session_marks')

    const outcome = await run()

    expect(outcome.status).toBe('failed')
    expect(outcome.reason).toBeTruthy()
    expect(db.all('SELECT count(*) AS n FROM ledger_meta')).toEqual([{ n: 0 }])
  })

  it('rolls the half-written vault back rather than leaving part of a history', async () => {
    const { sqlite, run } = fixture()
    const db = await createAppDatabase({ filePath: DB, sqlite }).connect()
    db.exec('DROP TABLE session_marks')

    await run()

    expect(db.all('SELECT mine_id FROM materials')).toEqual([])
  })

  it('lets a database that will not open at all reach the caller', async () => {
    // A corrupt or locked file is not a failed migration, and openLedgerStore
    // answers the two cases differently. Flattening them here would hide that.
    const { sqlite, run } = fixture()
    sqlite.failWith('corrupt')

    await expect(run()).rejects.toThrow()
  })
})
