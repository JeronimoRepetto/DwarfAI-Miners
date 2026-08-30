import { describe, expect, it } from 'vitest'
import { emptyLedger, serializeLedger, type LedgerState } from '../domain/ledger'
import { emptyMaterialTotals } from '../domain/materials'
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

/**
 * The tier walk has already measured every mine in these cases, and found
 * exactly the tier the mine is drawn as. A tier still being computed is its
 * own story, at the bottom of this file (#41).
 */
const confirmed = (target: Mine) => target.tier

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

    ledger.observe([crewedMine('mine:a', 'silver', 'claude:s1', 1_000)], 1, confirmed)
    const stamped = ledger.observe(
      [crewedMine('mine:a', 'silver', 'claude:s1', 3_500)],
      2,
      confirmed
    )

    expect(stamped[0]!.materials?.silver).toBe(2_500)
  })

  it('leaves the live tokensObserved gauge untouched', async () => {
    // The existing chip keeps working until the UI pass lands.
    const ledger = new MaterialLedger({ store: fakeStore() })
    await ledger.load()
    const input = mine({ id: 'mine:a', tokensObserved: 77 })
    expect(ledger.observe([input], 1, confirmed)[0]!.tokensObserved).toBe(77)
  })

  it('does not mutate the mines it was handed', async () => {
    const ledger = new MaterialLedger({ store: fakeStore() })
    await ledger.load()
    const input = crewedMine('mine:a', 'gold', 'claude:s1', 10)
    ledger.observe([input], 1, confirmed)
    expect(input.materials).toBeUndefined()
  })

  it('keeps a mines material after its whole crew leaves', async () => {
    const ledger = new MaterialLedger({ store: fakeStore() })
    await ledger.load()
    ledger.observe([crewedMine('mine:a', 'copper', 'claude:s1', 1_000)], 1, confirmed)
    ledger.observe([crewedMine('mine:a', 'copper', 'claude:s1', 6_000)], 2, confirmed)

    // The mine is still there but empty; the vault must not forget.
    const stamped = ledger.observe([mine({ id: 'mine:a', tier: 'copper' })], 3, confirmed)
    expect(stamped[0]!.materials?.copper).toBe(5_000)
  })

  it('reports a global total that includes mines absent from this poll', async () => {
    const ledger = new MaterialLedger({ store: fakeStore() })
    await ledger.load()
    ledger.creditCoal('mine:archived', 40_000)
    ledger.observe([crewedMine('mine:a', 'gold', 'claude:s1', 100)], 1, confirmed)
    ledger.observe([crewedMine('mine:a', 'gold', 'claude:s1', 700)], 2, confirmed)

    expect(ledger.totals().coal).toBe(40_000)
    expect(ledger.totals().gold).toBe(600)
  })
})

describe('MaterialLedger.load', () => {
  it('resumes from the stored ledger without re-crediting the stored counter', async () => {
    const before = new MaterialLedger({ store: fakeStore() })
    await before.load()
    before.observe([crewedMine('mine:a', 'copper', 'claude:s1', 1_000)], 1, confirmed)
    before.observe([crewedMine('mine:a', 'copper', 'claude:s1', 5_000)], 2, confirmed)
    await before.save(2, true)

    // Restart: a new ledger over the bytes the old one wrote.
    const persisted = before.state()
    const after = new MaterialLedger({ store: fakeStore(persisted) })
    await after.load()
    const stamped = after.observe(
      [crewedMine('mine:a', 'copper', 'claude:s1', 5_000)],
      3,
      confirmed
    )

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

    ledger.observe([crewedMine('mine:a', 'gold', 'claude:s1', 100)], 1, confirmed)
    ledger.observe([crewedMine('mine:a', 'gold', 'claude:s1', 200)], 2, confirmed)
    await ledger.save(2)
    expect(store.saves).toHaveLength(1)

    ledger.observe([crewedMine('mine:a', 'gold', 'claude:s1', 300)], 3, confirmed)
    await ledger.save(3)
    expect(store.saves).toHaveLength(1)

    await ledger.save(2 + SAVE_INTERVAL_MS)
    expect(store.saves).toHaveLength(2)
  })

  it('writes immediately when forced, which is what shutdown does', async () => {
    const store = fakeStore()
    const ledger = new MaterialLedger({ store })
    await ledger.load()
    ledger.observe([crewedMine('mine:a', 'gold', 'claude:s1', 100)], 1, confirmed)
    ledger.observe([crewedMine('mine:a', 'gold', 'claude:s1', 900)], 2, confirmed)

    await ledger.save(2)
    await ledger.observe([crewedMine('mine:a', 'gold', 'claude:s1', 1_900)], 3, confirmed)
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
    ledger.observe([crewedMine('mine:a', 'gold', 'claude:s1', 100)], 1, confirmed)
    ledger.observe([crewedMine('mine:a', 'gold', 'claude:s1', 900)], 2, confirmed)

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
    ledger.observe([crewedMine('mine:a', 'gold', 'claude:s1', 100)], 1, confirmed)
    ledger.observe([crewedMine('mine:a', 'gold', 'claude:s1', 900)], 2, confirmed)

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
    ledger.observe([crewedMine('mine:a', 'gold', 'claude:s1', 100)], 1, confirmed)
    ledger.observe([crewedMine('mine:a', 'gold', 'claude:s1', 900)], 2, confirmed)

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
    const stamped = ledger.observe([mine({ id: 'mine:a', tier: 'bronze' })], 1, confirmed)
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

/**
 * #41: the vault credited phantom bronze for the first seconds after every
 * start, because tierOf() serves a provisional 'bronze' until the first walk
 * finishes and the ledger sealed deltas with it. A provisional tier is for
 * drawing only; the vault waits.
 */
describe('MaterialLedger.observe: a tier that is still being computed (#41)', () => {
  /** The walk has not finished for any mine yet. */
  const pending = () => undefined

  it('accrues nothing for a mine whose tier has not been computed yet', async () => {
    const ledger = new MaterialLedger({ store: fakeStore() })
    await ledger.load()

    ledger.observe([crewedMine('mine:a', 'bronze', 'claude:s1', 1_000)], 1, pending)
    const stamped = ledger.observe(
      [crewedMine('mine:a', 'bronze', 'claude:s1', 13_094)],
      2,
      pending
    )

    expect(stamped[0]!.materials?.bronze).toBe(0)
    expect(ledger.totals()).toEqual(emptyMaterialTotals())
  })

  it('credits the tokens burned during the wait in full, to the tier the walk found', async () => {
    // The provider counter is cumulative, so the whole 1 000 -> 6 000 span
    // lands as silver on the first poll that knows the tier — nothing is
    // dropped, and none of it is bronze.
    const ledger = new MaterialLedger({ store: fakeStore() })
    await ledger.load()

    ledger.observe([crewedMine('mine:a', 'bronze', 'claude:s1', 1_000)], 1, pending)
    ledger.observe([crewedMine('mine:a', 'bronze', 'claude:s1', 4_000)], 2, pending)
    const stamped = ledger.observe(
      [crewedMine('mine:a', 'silver', 'claude:s1', 6_000)],
      3,
      confirmed
    )

    expect(stamped[0]!.materials?.silver).toBe(5_000)
    expect(stamped[0]!.materials?.bronze).toBe(0)
  })

  it('accrues immediately for a mine whose tier is already known', async () => {
    const ledger = new MaterialLedger({ store: fakeStore() })
    await ledger.load()

    ledger.observe([crewedMine('mine:a', 'silver', 'claude:s1', 1_000)], 1, confirmed)
    const stamped = ledger.observe(
      [crewedMine('mine:a', 'silver', 'claude:s1', 3_500)],
      2,
      confirmed
    )

    expect(stamped[0]!.materials?.silver).toBe(2_500)
  })

  it('never double-counts the wait, however many polls it spans', async () => {
    const ledger = new MaterialLedger({ store: fakeStore() })
    await ledger.load()

    for (const tokens of [1_000, 4_000, 8_000]) {
      ledger.observe([crewedMine('mine:a', 'bronze', 'claude:s1', tokens)], 1, pending)
    }
    ledger.observe([crewedMine('mine:a', 'silver', 'claude:s1', 10_000)], 2, confirmed)
    ledger.observe([crewedMine('mine:a', 'silver', 'claude:s1', 12_000)], 3, confirmed)

    // Exactly the growth since the first counter the vault ever saw, credited
    // once: 12 000 - 1 000, with nothing left in bronze.
    expect(ledger.totals().silver).toBe(11_000)
    expect(ledger.totals().bronze).toBe(0)
  })
})
