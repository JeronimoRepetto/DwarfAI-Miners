// layer: L2
// L2 (17 §1.2): `LedgerCommands` and `LedgerQueries` (16 §4.10) over the in-memory doubles, which
// pass the same contract as the SQLite adapter. The bus refuses a publish inside a transaction
// (16 §2.3), so every event seen here was published after a commit.
import { describe, expect, it } from 'vitest'
import type { UsageObservation } from '../../../kernel/domain/sharedContracts'
import type { DwarfId, MineId } from '../../../kernel/domain/values'
import { MATERIALS } from '../domain/materials'
import { inMemoryLedger } from '../testing/inMemoryLedger'

const INSTALL = 1_760_000_000_000

let keys = 0

/** A sealed observation of `unitKey` after the install moment, with `inputNet` tokens. */
function usage(
  dwarfId: DwarfId,
  unitKey: string,
  inputNet: number,
  overrides: Partial<UsageObservation> = {}
): UsageObservation {
  keys += 1
  return {
    sourceKey: `claude:${unitKey}:${keys}`,
    unitKey,
    dwarfId,
    fidelity: 1,
    tokens: { inputNet, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    sealed: true,
    providerTime: INSTALL + 1_000,
    observedAt: INSTALL + 1_100,
    ...overrides
  }
}

function world() {
  const w = inMemoryLedger()
  w.setInstallMoment(INSTALL)
  return w
}

describe('LedgerCommands and LedgerQueries', () => {
  it("[INV-92] a dwarf's usagePath written at bind is the only path credited for its whole life: a transcript observation of a driver-path dwarf is stored, never credited, also after its LaunchRecord is deleted", () => {
    const w = world()
    const mine = w.addMine('copper')
    const owned = w.addDwarf(mine, 'driver')
    const transcript = w.ledger.commandsFor('transcript')

    expect(transcript.creditUsage(usage(owned, 'u-1', 30_000))).toBe('stored')
    // The LaunchRecord is deleted 7 days after the session ended (09 §7.1); the ledger never reads
    // it: the dwarf's stored path still decides, so a later transcript read cannot switch paths.
    expect(transcript.creditUsage(usage(owned, 'u-2', 30_000))).toBe('stored')
    expect(w.entries(mine)).toEqual([])

    // The authoritative path's observation of the same unit is the one credited.
    expect(w.ledger.commandsFor('driver').creditUsage(usage(owned, 'u-1', 40_000))).toBe('credited')
    expect(w.ledger.queries.totals(mine).copper).toEqual({ tokens: 40_000 })
  })

  it('[US-MINE-010.AC01, US-MINE-010.AC04] the totals of a mine list each held material with its own count and zero for the others', () => {
    const w = world()
    const mine = w.addMine('copper')
    const dwarf = w.addDwarf(mine, 'transcript')
    const commands = w.ledger.commandsFor('transcript')

    expect(commands.creditUsage(usage(dwarf, 'u-1', 30_000))).toBe('credited')
    // The mine grows into silver (a new measurement): later units pay silver, the copper stays.
    w.measure(mine, 'silver')
    expect(commands.creditUsage(usage(dwarf, 'u-2', 70_000))).toBe('credited')

    expect(w.ledger.queries.totals(mine)).toEqual({
      coal: { tokens: 0 },
      bronze: { tokens: 0 },
      copper: { tokens: 30_000 },
      silver: { tokens: 70_000 },
      gold: { tokens: 0 },
      uranium: { tokens: 0 }
    })
    expect(w.entries(mine)).toEqual([
      { unitKey: 'u-1', material: 'copper', tokens: 30_000, units: 1, kind: 'live' },
      { unitKey: 'u-2', material: 'silver', tokens: 70_000, units: 1, kind: 'live' }
    ])
  })

  it("[US-MINE-010.AC05] summing each material over every mine's totals equals that material's ledger sum", () => {
    const w = world()
    const mines: MineId[] = [w.addMine('bronze'), w.addMine('gold'), w.addMine('bronze')]
    mines.forEach((mine, n) => {
      const dwarf = w.addDwarf(mine, 'transcript')
      const commands = w.ledger.commandsFor('transcript')
      commands.creditUsage(usage(dwarf, `u-${n}-a`, 11_000 * (n + 1)))
      commands.creditUsage(usage(dwarf, `u-${n}-b`, 3_000 * (n + 1)))
    })

    const entries = mines.flatMap((mine) => w.entries(mine))
    for (const material of MATERIALS) {
      const acrossMines = mines.reduce(
        (sum, mine) => sum + w.ledger.queries.totals(mine)[material].tokens,
        0
      )
      const ledgerSum = entries
        .filter((entry) => entry.material === material)
        .reduce((sum, entry) => sum + entry.tokens, 0)
      expect(acrossMines).toBe(ledgerSum)
    }
    expect(entries).toHaveLength(6)
  })

  it('[FM-094] a unit seen by the driver path and the transcript path is credited once', () => {
    const w = world()
    const mine = w.addMine('gold')
    const owned = w.addDwarf(mine, 'driver')
    const observed = w.addDwarf(mine, 'transcript')

    // Driver first, then the transcript reports the same unit under another key.
    expect(
      w.ledger.commandsFor('driver').creditUsage(usage(owned, 'u-1', 100_000, { fidelity: 2 }))
    ).toBe('credited')
    expect(w.ledger.commandsFor('transcript').creditUsage(usage(owned, 'u-1', 100_000))).toBe(
      'stored'
    )
    // Transcript first for an observed session, then a driver-side report of the same unit.
    expect(
      w.ledger.commandsFor('driver').creditUsage(usage(observed, 'u-2', 200_000, { fidelity: 2 }))
    ).toBe('stored')
    expect(w.ledger.commandsFor('transcript').creditUsage(usage(observed, 'u-2', 200_000))).toBe(
      'credited'
    )
    // A re-read of the same record inserts nothing.
    const reRead = usage(observed, 'u-3', 100_000)
    expect(w.ledger.commandsFor('transcript').creditUsage(reRead)).toBe('credited')
    expect(w.ledger.commandsFor('transcript').creditUsage(reRead)).toBe('duplicate')

    expect(w.entries(mine).map((entry) => entry.unitKey)).toEqual(['u-1', 'u-2', 'u-3'])
    expect(w.ledger.queries.totals(mine).gold).toEqual({ tokens: 400_000 })
    expect(w.bus.ofType('MaterialCredited')).toHaveLength(3)
  })

  it('[INV-94] once the mine is measured creditSealedUnits credits each stored sealed unit once and a second call credits none', () => {
    const w = world()
    const mine = w.addMine(null)
    const dwarf = w.addDwarf(mine, 'transcript')
    const commands = w.ledger.commandsFor('transcript')

    expect(commands.creditUsage(usage(dwarf, 'u-1', 50_000))).toBe('stored')
    expect(commands.creditUsage(usage(dwarf, 'u-2', 100_000))).toBe('stored')
    expect(commands.creditUsage(usage(dwarf, 'u-open', 9_000, { sealed: false }))).toBe('stored')
    expect(w.entries(mine)).toEqual([])
    // Still measuring: nothing to credit yet.
    expect(commands.creditSealedUnits(mine)).toEqual({ credited: 0 })

    w.measure(mine, 'silver')
    expect(commands.creditSealedUnits(mine)).toEqual({ credited: 2 })
    expect(commands.creditSealedUnits(mine)).toEqual({ credited: 0 })
    expect(w.entries(mine)).toEqual([
      { unitKey: 'u-1', material: 'silver', tokens: 50_000, units: 1, kind: 'live' },
      { unitKey: 'u-2', material: 'silver', tokens: 100_000, units: 2, kind: 'live' }
    ])
    expect(w.bus.ofType('LedgerTotalsChanged').map((e) => e.payload.totals.silver)).toEqual([
      { tokens: 50_000 },
      { tokens: 150_000 }
    ])
  })

  it('[ADR-006] each credit publishes MaterialCredited and LedgerTotalsChanged after its commit, and a stored or duplicate observation publishes nothing', () => {
    const w = world()
    const mine = w.addMine('bronze')
    const dwarf = w.addDwarf(mine, 'transcript')
    const commands = w.ledger.commandsFor('transcript')

    commands.creditUsage(usage(dwarf, 'u-1', 9_000, { sealed: false }))
    expect(w.bus.published).toEqual([])
    // The sealing record is the better observation (fidelity 2), so it is the one credited.
    commands.creditUsage(usage(dwarf, 'u-1', 25_000, { fidelity: 2, observedAt: INSTALL + 1_200 }))

    const [credited, changed] = w.bus.published
    expect(w.bus.published.map((e) => e.type)).toEqual(['MaterialCredited', 'LedgerTotalsChanged'])
    expect(credited?.payload).toEqual({
      mineId: mine,
      material: 'bronze',
      tokens: 25_000,
      units: 2,
      unitKey: 'u-1',
      kind: 'live'
    })
    expect(changed?.payload).toMatchObject({
      mineId: mine,
      totals: { bronze: { tokens: 25_000 }, copper: { tokens: 0 } }
    })
    expect(changed?.type === 'LedgerTotalsChanged' && changed.payload.ledgerEntryId).toMatch(
      /^[0-9a-f-]{36}$/
    )
    expect(w.transactions.committed).toBe(2)
  })

  it("[ADR-006] inside the caller's batch transaction a credit publishes only after the caller commits and nothing when it rolls back", () => {
    const w = world()
    const mine = w.addMine('bronze')
    const dwarf = w.addDwarf(mine, 'transcript')
    const commands = w.ledger.commandsFor('transcript')

    w.transactions.inTransaction(() => {
      expect(commands.creditUsage(usage(dwarf, 'u-1', 10_000))).toBe('credited')
    })
    expect(w.bus.published).toEqual([])
    w.ledger.publishCommitted()
    expect(w.bus.published.map((e) => e.type)).toEqual(['MaterialCredited', 'LedgerTotalsChanged'])

    expect(() =>
      w.transactions.inTransaction(() => {
        commands.creditUsage(usage(dwarf, 'u-2', 10_000))
        throw new Error('the batch failed')
      })
    ).toThrow('the batch failed')
    w.ledger.discardUncommitted()
    w.ledger.publishCommitted()
    expect(w.bus.published).toHaveLength(2)
    expect(w.entries(mine).map((entry) => entry.unitKey)).toEqual(['u-1'])
  })

  it('[INV-97] while a reset saga is not done usage is stored and is credited once the saga is done', () => {
    const w = world()
    const mine = w.addMine('bronze')
    const dwarf = w.addDwarf(mine, 'transcript')
    const commands = w.ledger.commandsFor('transcript')

    w.setResetInProgress(true)
    expect(commands.creditUsage(usage(dwarf, 'u-1', 10_000))).toBe('stored')
    w.setResetInProgress(false)
    expect(commands.creditUsage(usage(dwarf, 'u-2', 10_000))).toBe('credited')
    expect(w.entries(mine).map((entry) => entry.unitKey)).toEqual(['u-2'])
  })
})
