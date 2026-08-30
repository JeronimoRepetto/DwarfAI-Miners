import { describe, expect, it } from 'vitest'
import { emptyLedger, serializeLedger, type LedgerState } from '../domain/ledger'
import { defaultDwarf, defaultMine, type Mine } from '../domain/types'
import { MaterialLedger, SAVE_INTERVAL_MS } from './materialLedger'
import type { LedgerStore } from './ledgerStore'

function mine(overrides: Partial<Mine>): Mine {
  return { ...defaultMine(), ...overrides }
}

/** A mine holding one dwarf whose counter currently reads `tokens`. */
function crewedMine(id: string, tier: Mine['tier'], sessionId: string, tokens: number): Mine {
  return mine({
    id,
    tier,
    dwarfs: [{ ...defaultDwarf(), id: sessionId, tokensObserved: tokens }]
  })
}

/** Deterministic store fake recording every save, newest last. */
function fakeStore(initial: LedgerState = emptyLedger()): LedgerStore & { saves: LedgerState[] } {
  const saves: LedgerState[] = []
  return {
    saves,
    async load() {
      return initial
    },
    async save(state) {
      saves.push(state)
    }
  }
}

describe('MaterialLedger.observe', () => {
  it('stamps each mine with its own persisted breakdown', async () => {
    const ledger = new MaterialLedger({ store: fakeStore() })
    await ledger.load()

    ledger.observe([crewedMine('mine:a', 'silver', 'claude:s1', 1_000)], 1)
    const stamped = ledger.observe([crewedMine('mine:a', 'silver', 'claude:s1', 3_500)], 2)

    expect(stamped[0]!.materials?.silver).toBe(2_500)
  })

  it('leaves the live tokensObserved gauge untouched', async () => {
    // The existing chip keeps working until the UI pass lands.
    const ledger = new MaterialLedger({ store: fakeStore() })
    await ledger.load()
    const input = mine({ id: 'mine:a', tokensObserved: 77 })
    expect(ledger.observe([input], 1)[0]!.tokensObserved).toBe(77)
  })

  it('does not mutate the mines it was handed', async () => {
    const ledger = new MaterialLedger({ store: fakeStore() })
    await ledger.load()
    const input = crewedMine('mine:a', 'gold', 'claude:s1', 10)
    ledger.observe([input], 1)
    expect(input.materials).toBeUndefined()
  })

  it('keeps a mines material after its whole crew leaves', async () => {
    const ledger = new MaterialLedger({ store: fakeStore() })
    await ledger.load()
    ledger.observe([crewedMine('mine:a', 'copper', 'claude:s1', 1_000)], 1)
    ledger.observe([crewedMine('mine:a', 'copper', 'claude:s1', 6_000)], 2)

    // The mine is still there but empty; the vault must not forget.
    const stamped = ledger.observe([mine({ id: 'mine:a', tier: 'copper' })], 3)
    expect(stamped[0]!.materials?.copper).toBe(5_000)
  })

  it('reports a global total that includes mines absent from this poll', async () => {
    const ledger = new MaterialLedger({ store: fakeStore() })
    await ledger.load()
    ledger.creditCoal('mine:archived', 40_000)
    ledger.observe([crewedMine('mine:a', 'gold', 'claude:s1', 100)], 1)
    ledger.observe([crewedMine('mine:a', 'gold', 'claude:s1', 700)], 2)

    expect(ledger.totals().coal).toBe(40_000)
    expect(ledger.totals().gold).toBe(600)
  })
})

describe('MaterialLedger.load', () => {
  it('resumes from the stored ledger without re-crediting the stored counter', async () => {
    const before = new MaterialLedger({ store: fakeStore() })
    await before.load()
    before.observe([crewedMine('mine:a', 'copper', 'claude:s1', 1_000)], 1)
    before.observe([crewedMine('mine:a', 'copper', 'claude:s1', 5_000)], 2)
    await before.save(2, true)

    // Restart: a new ledger over the bytes the old one wrote.
    const persisted = before.state()
    const after = new MaterialLedger({ store: fakeStore(persisted) })
    await after.load()
    const stamped = after.observe([crewedMine('mine:a', 'copper', 'claude:s1', 5_000)], 3)

    expect(stamped[0]!.materials?.copper).toBe(4_000)
  })

  it('starts from an empty vault when the store cannot load, without throwing', async () => {
    const store = fakeStore()
    store.load = async () => {
      throw new Error('EACCES')
    }
    const ledger = new MaterialLedger({ store })
    await expect(ledger.load()).resolves.toBeUndefined()
    expect(ledger.totals().gold).toBe(0)
  })
})

describe('MaterialLedger.save', () => {
  it('does not write when nothing has been accrued', async () => {
    const store = fakeStore()
    const ledger = new MaterialLedger({ store })
    await ledger.load()
    await ledger.save(SAVE_INTERVAL_MS * 10)
    expect(store.saves).toHaveLength(0)
  })

  it('throttles writes so a two-second poll does not hammer the disk', async () => {
    const store = fakeStore()
    const ledger = new MaterialLedger({ store })
    await ledger.load()

    ledger.observe([crewedMine('mine:a', 'gold', 'claude:s1', 100)], 1)
    ledger.observe([crewedMine('mine:a', 'gold', 'claude:s1', 200)], 2)
    await ledger.save(2)
    expect(store.saves).toHaveLength(1)

    ledger.observe([crewedMine('mine:a', 'gold', 'claude:s1', 300)], 3)
    await ledger.save(3)
    expect(store.saves).toHaveLength(1)

    await ledger.save(2 + SAVE_INTERVAL_MS)
    expect(store.saves).toHaveLength(2)
  })

  it('writes immediately when forced, which is what shutdown does', async () => {
    const store = fakeStore()
    const ledger = new MaterialLedger({ store })
    await ledger.load()
    ledger.observe([crewedMine('mine:a', 'gold', 'claude:s1', 100)], 1)
    ledger.observe([crewedMine('mine:a', 'gold', 'claude:s1', 900)], 2)

    await ledger.save(2)
    await ledger.observe([crewedMine('mine:a', 'gold', 'claude:s1', 1_900)], 3)
    await ledger.save(3, true)

    expect(store.saves).toHaveLength(2)
    expect(store.saves.at(-1)!.mines['mine:a']?.gold).toBe(1_800)
  })

  it('reports a write failure instead of throwing into the poll loop', async () => {
    // A persistence hiccup must never kill the polling that feeds the panel.
    const store = fakeStore()
    store.save = async () => {
      throw new Error('ENOSPC')
    }
    const errors: unknown[] = []
    const ledger = new MaterialLedger({ store, onError: (_m, error) => errors.push(error) })
    await ledger.load()
    ledger.observe([crewedMine('mine:a', 'gold', 'claude:s1', 100)], 1)
    ledger.observe([crewedMine('mine:a', 'gold', 'claude:s1', 900)], 2)

    await expect(ledger.save(2, true)).resolves.toBeUndefined()
    expect(errors).toHaveLength(1)
  })

  it('keeps the change pending after a failed write, so the next save retries it', async () => {
    const store = fakeStore()
    let fail = true
    store.save = async (state) => {
      if (fail) throw new Error('ENOSPC')
      store.saves.push(state)
    }
    const ledger = new MaterialLedger({ store, onError: () => undefined })
    await ledger.load()
    ledger.observe([crewedMine('mine:a', 'gold', 'claude:s1', 100)], 1)
    ledger.observe([crewedMine('mine:a', 'gold', 'claude:s1', 900)], 2)

    await ledger.save(2, true)
    fail = false
    await ledger.save(3, true)

    expect(store.saves).toHaveLength(1)
    expect(store.saves[0]!.mines['mine:a']?.gold).toBe(800)
  })

  it('prunes stale session bookkeeping on the way out without losing material', async () => {
    const store = fakeStore()
    const ledger = new MaterialLedger({ store })
    await ledger.load()
    ledger.observe([crewedMine('mine:a', 'gold', 'claude:s1', 100)], 1)
    ledger.observe([crewedMine('mine:a', 'gold', 'claude:s1', 900)], 2)

    await ledger.save(2 + SAVE_INTERVAL_MS * 100_000, true)
    const saved = store.saves.at(-1)!
    expect(saved.sessions['claude:s1']).toBeUndefined()
    expect(saved.mines['mine:a']?.gold).toBe(800)
  })
})

describe('MaterialLedger.creditCoal', () => {
  it('credits coal that no amount of live polling could produce', async () => {
    const ledger = new MaterialLedger({ store: fakeStore() })
    await ledger.load()
    ledger.creditCoal('mine:a', 12_345)
    expect(ledger.totals().coal).toBe(12_345)
  })

  it('marks the vault dirty so the credited coal is persisted', async () => {
    const store = fakeStore()
    const ledger = new MaterialLedger({ store })
    await ledger.load()
    ledger.creditCoal('mine:a', 500)
    await ledger.save(1, true)
    expect(store.saves.at(-1)!.mines['mine:a']?.coal).toBe(500)
  })

  it('shows coal on the mine it belongs to when that project is mined again', async () => {
    const ledger = new MaterialLedger({ store: fakeStore() })
    await ledger.load()
    ledger.creditCoal('mine:a', 9_000)
    const stamped = ledger.observe([mine({ id: 'mine:a', tier: 'bronze' })], 1)
    expect(stamped[0]!.materials?.coal).toBe(9_000)
  })
})

describe('MaterialLedger.state', () => {
  it('exposes exactly what would be written, for the store to serialize', async () => {
    const ledger = new MaterialLedger({ store: fakeStore() })
    await ledger.load()
    ledger.creditCoal('mine:a', 10)
    expect(() => serializeLedger(ledger.state())).not.toThrow()
  })
})
