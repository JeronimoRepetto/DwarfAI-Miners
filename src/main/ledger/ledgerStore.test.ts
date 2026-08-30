import { describe, expect, it } from 'vitest'
import { accrue, emptyLedger, mineTotals, serializeLedger } from '../domain/ledger'
import { createLedgerStore, type LedgerFsLike } from './ledgerStore'

const FILE = 'C:\\userData\\material-ledger-v1.json'

/** Deterministic fake: an in-memory map plus a record of every write, in order. */
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

describe('createLedgerStore', () => {
  it('loads an empty ledger when the file has never been written', async () => {
    const store = createLedgerStore({ filePath: FILE, fs: fakeFs() })
    expect(await store.load()).toEqual(emptyLedger())
  })

  it('round-trips accrued material through a save and a fresh load', async () => {
    const fs = fakeFs()
    const earned = accrue(
      accrue(
        emptyLedger(),
        [{ mineId: 'mine:a', sessionKey: 'claude:s1', material: 'gold', tokensObserved: 1_000 }],
        1
      ),
      [{ mineId: 'mine:a', sessionKey: 'claude:s1', material: 'gold', tokensObserved: 4_000 }],
      2
    )

    await createLedgerStore({ filePath: FILE, fs }).save(earned)
    // A brand-new store, as a restarted app would build.
    const restored = await createLedgerStore({ filePath: FILE, fs }).load()

    expect(mineTotals(restored, 'mine:a').gold).toBe(3_000)
    expect(restored.sessions['claude:s1']).toEqual({ tokens: 4_000, seenAt: 2 })
  })

  it('writes through a sibling temp file and renames it onto the target', async () => {
    // A crash mid-write must be able to leave only the previous intact file or
    // a stray temp file behind, never a torn ledger.
    const fs = fakeFs()
    await createLedgerStore({ filePath: FILE, fs }).save(emptyLedger())
    expect(fs.writes).toEqual([`${FILE}.tmp`])
    expect(fs.files.has(`${FILE}.tmp`)).toBe(false)
    expect(fs.files.get(FILE)).toBe(serializeLedger(emptyLedger()))
  })

  it('falls back to an empty ledger when the stored file is corrupt', async () => {
    const store = createLedgerStore({ filePath: FILE, fs: fakeFs({ [FILE]: '{ truncated' }) })
    expect(await store.load()).toEqual(emptyLedger())
  })

  it('falls back to an empty ledger when the file cannot be read at all', async () => {
    const fs = fakeFs()
    fs.readFile = async () => {
      throw new Error('EACCES')
    }
    expect(await createLedgerStore({ filePath: FILE, fs }).load()).toEqual(emptyLedger())
  })

  it('propagates a write failure so the caller can log it', async () => {
    // The vault is still correct in memory; only the caller can decide how
    // loudly a persistence hiccup should be reported.
    const fs = fakeFs()
    fs.writeFile = async () => {
      throw new Error('ENOSPC')
    }
    await expect(createLedgerStore({ filePath: FILE, fs }).save(emptyLedger())).rejects.toThrow(
      'ENOSPC'
    )
  })
})
