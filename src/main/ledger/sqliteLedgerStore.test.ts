import { describe, expect, it } from 'vitest'
import { MemoryWritableSqlite } from '../adapters/memoryWritableSqlite'
import { createAppDatabase } from '../appDatabase/appDatabase'
import { accrue, creditMaterial, emptyLedger, mineTotals, pruneSessions } from '../domain/ledger'
import { createSqliteLedgerStore } from './sqliteLedgerStore'

const DB = 'C:\\userData\\projects-v1.db'

function newStore(sqlite = new MemoryWritableSqlite()): {
  store: ReturnType<typeof createSqliteLedgerStore>
  sqlite: MemoryWritableSqlite
} {
  return {
    sqlite,
    store: createSqliteLedgerStore({ database: createAppDatabase({ filePath: DB, sqlite }) })
  }
}

/** Two polls of one gold session: a baseline, then 3,000 tokens of growth. */
function goldEarned(): ReturnType<typeof emptyLedger> {
  return accrue(
    accrue(
      emptyLedger(),
      [{ mineId: 'mine:a', sessionKey: 'claude:s1', material: 'gold', tokensObserved: 1_000 }],
      1
    ),
    [{ mineId: 'mine:a', sessionKey: 'claude:s1', material: 'gold', tokensObserved: 4_000 }],
    2
  )
}

describe('sqlite ledger store — round trip', () => {
  it('restores accrued material and session marks a restarted app would need', async () => {
    const { store, sqlite } = newStore()

    await store.save(goldEarned())
    // A brand-new store over the same file, as a restarted app would build.
    const restored = await createSqliteLedgerStore({
      database: createAppDatabase({ filePath: DB, sqlite })
    }).load()

    expect(mineTotals(restored, 'mine:a').gold).toBe(3_000)
    expect(restored.sessions['claude:s1']).toEqual({ tokens: 4_000, seenAt: 2 })
  })

  it('answers an empty vault for a database that has never been written', async () => {
    // Empty is a truthful answer here, and the only one: a database that opened
    // and prepared its schema has genuinely no ore yet.
    const { store } = newStore()
    expect(await store.load()).toEqual(emptyLedger())
  })

  it('keeps every material in its own row, with nothing summed across them', async () => {
    // MATERIAL_TOKENS_PER_UNIT is a grain size, not an exchange rate: a schema
    // that could hold one total per mine would be a place to break that.
    const { store, sqlite } = newStore()
    const mixed = creditMaterial(
      creditMaterial(emptyLedger(), 'mine:a', 'gold', 900),
      'mine:a',
      'coal',
      120
    )

    await store.save(mixed)

    const db = await sqlite.open(DB)
    expect(
      db.all('SELECT material, tokens FROM materials WHERE mine_id = ? ORDER BY material', [
        'mine:a'
      ])
    ).toEqual([
      { material: 'coal', tokens: 120 },
      { material: 'gold', tokens: 900 }
    ])
  })

  it('writes a row only for a material the mine has actually produced', async () => {
    const { store, sqlite } = newStore()

    await store.save(creditMaterial(emptyLedger(), 'mine:a', 'silver', 50))

    const db = await sqlite.open(DB)
    expect(db.all('SELECT material FROM materials')).toEqual([{ material: 'silver' }])
  })

  it('survives a token count far past what one session could burn', async () => {
    // node:sqlite hands an INTEGER column back as a number or a bigint
    // depending on its size, and a vault that read the second as null would
    // report a heavy user's history as gone.
    const { store, sqlite } = newStore()
    const huge = 9_007_199_254_740_990

    await store.save(creditMaterial(emptyLedger(), 'mine:a', 'uranium', huge))

    const restored = await createSqliteLedgerStore({
      database: createAppDatabase({ filePath: DB, sqlite })
    }).load()
    expect(mineTotals(restored, 'mine:a').uranium).toBe(huge)
  })
})

describe('sqlite ledger store — a save is the whole vault', () => {
  it('lets a pruned session mark disappear instead of lingering forever', async () => {
    // The state handed to save() is the state, in full. Anything the domain
    // dropped on the way out (pruneSessions) has to be gone from the file too,
    // or the table would only ever grow.
    const { store, sqlite } = newStore()
    const earned = goldEarned()
    await store.save(earned)

    await store.save(pruneSessions(earned, 3, 0))

    const db = await sqlite.open(DB)
    expect(db.all('SELECT key FROM session_marks')).toEqual([])
    // The material it earned is NOT bookkeeping and never goes with it.
    expect(db.all('SELECT tokens FROM materials')).toEqual([{ tokens: 3_000 }])
  })

  it('does not leave a mine behind after its last row is written away', async () => {
    const { store, sqlite } = newStore()
    await store.save(creditMaterial(emptyLedger(), 'mine:gone', 'gold', 10))

    await store.save(creditMaterial(emptyLedger(), 'mine:here', 'gold', 20))

    const db = await sqlite.open(DB)
    expect(db.all('SELECT mine_id FROM materials')).toEqual([{ mine_id: 'mine:here' }])
  })
})

describe('sqlite ledger store — failures it must not hide', () => {
  it('leaves the previous vault intact when a save cannot finish', async () => {
    // One transaction, and this proves it: the vault is emptied before it is
    // rewritten, so a failure between the two would show the user a zeroed
    // history that is still on disk.
    const { store, sqlite } = newStore()
    await store.save(goldEarned())
    const db = await sqlite.open(DB)
    db.exec('DROP TABLE session_marks')

    await expect(store.save(creditMaterial(emptyLedger(), 'mine:b', 'gold', 1))).rejects.toThrow()

    expect(db.all('SELECT mine_id, tokens FROM materials')).toEqual([
      { mine_id: 'mine:a', tokens: 3_000 }
    ])
  })

  it('rejects rather than answering an empty vault when the database will not open', async () => {
    // The whole reason the app's own store gets its own port: "no rows" from it
    // is indistinguishable from an empty vault, and would report a user's
    // entire mined history as gone.
    const sqlite = new MemoryWritableSqlite()
    sqlite.failWith('corrupt')
    const { store } = newStore(sqlite)

    await expect(store.load()).rejects.toThrow()
  })

  it('rejects a save the database refuses, so the caller can keep it dirty', async () => {
    const sqlite = new MemoryWritableSqlite()
    sqlite.failWith('locked')
    const { store } = newStore(sqlite)

    await expect(store.save(emptyLedger())).rejects.toThrow()
  })
})
