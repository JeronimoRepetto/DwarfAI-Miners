import { describe, expect, it } from 'vitest'
import { MAP_SPAWN_SITE_COUNT, type Dwarf, type ProviderSnapshot } from '../../domain/types'
import { defaultSimulationConfig, type SimulationConfig } from '../../config/config'
import { SHOWCASE_MINE_INDEX, simulatedMines, simulatedSnapshots } from './world'

/*
 * The authored cave interior this simulation exists to overcrowd, counted from
 * `src/renderer/src/lib/sceneLayout.ts`. Hard-coded rather than imported: the
 * main process must not reach across the process boundary for renderer art,
 * and a change to the interior SHOULD fail this test loudly — the whole value
 * of the simulation is that the crowded crew still outnumbers the anchors.
 */
const VEIN_ANCHORS = 4
const REST_ANCHORS = 2
const POST_ANCHORS = 1

/**
 * The world map's spawn locations. This was 13 — the hand-authored sites of
 * `mapSites.ts`, which the default simulated valley deliberately OVERFLOWED so
 * the crowded path was exercised (#20). The design's map has 74 (#136), so the
 * relationship inverted rather than disappeared: the default valley now fits,
 * and every simulated mine gets a spawn location of its own.
 */
const MAP_SITES = MAP_SPAWN_SITE_COUNT

function config(overrides: Partial<SimulationConfig> = {}): SimulationConfig {
  return { ...defaultSimulationConfig(), ...overrides }
}

function allDwarfs(snapshots: readonly ProviderSnapshot[]): Dwarf[] {
  return snapshots.flatMap((snapshot) => snapshot.dwarfs)
}

/** A fixed wall clock, so `updatedAt` never makes an assertion depend on the hour. */
const NOW_MS = 1_700_000_000_000

function worldAt(spec: SimulationConfig, tick: number): ProviderSnapshot[] {
  return simulatedSnapshots(spec, simulatedMines(spec), tick, NOW_MS)
}

function showcaseDwarfs(spec: SimulationConfig, tick: number): Dwarf[] {
  const showcase = simulatedMines(spec)[SHOWCASE_MINE_INDEX]!
  return allDwarfs(worldAt(spec, tick).filter((snapshot) => snapshot.cwd === showcase.path))
}

describe('simulatedMines', () => {
  it('produces exactly the configured number of mines', () => {
    expect(simulatedMines(config({ mines: 7 }))).toHaveLength(7)
  })

  /*
    The assertion this replaced said the default valley OVERFLOWS the map, which
    was true of thirteen sites and is false of seventy-four. What is worth
    pinning now is the other side of the same fact: every simulated mine can
    have a spawn location to itself, so the demo never shows two mines sharing
    one — and raising the default past 74 fails here loudly rather than quietly
    stacking markers.
  */
  it('fits inside the map’s spawn locations at the default settings (#20, #136)', () => {
    expect(defaultSimulationConfig().mines).toBeLessThanOrEqual(MAP_SITES)
  })

  it('gives every mine a distinct path and a non-empty display name', () => {
    const mines = simulatedMines(config())
    expect(new Set(mines.map((mine) => mine.path)).size).toBe(mines.length)
    for (const mine of mines) {
      expect(mine.name).not.toBe('')
      // The name has to be the last path segment, because that is what
      // aggregateMines derives a mine's display name from.
      expect(mine.path.endsWith(mine.name)).toBe(true)
    }
  })

  it('marks every path as simulated, so an invented mine is recognisable on sight', () => {
    for (const mine of simulatedMines(config())) {
      expect(mine.path.toLowerCase()).toContain('simulated')
    }
  })

  it('spreads the configured tiers so every one of them is actually on screen', () => {
    const spec = config()
    const tiers = new Set(simulatedMines(spec).map((mine) => mine.tier))
    expect(tiers).toEqual(new Set(spec.tiers))
  })

  it('uses only the configured tiers when the spread is narrowed', () => {
    const mines = simulatedMines(config({ tiers: ['gold', 'uranium'] }))
    expect(new Set(mines.map((mine) => mine.tier))).toEqual(new Set(['gold', 'uranium']))
  })

  it('is stable across ticks: a mine never changes tier, path or name', () => {
    expect(simulatedMines(config())).toEqual(simulatedMines(config()))
  })

  it('renames the valley when the seed changes', () => {
    const a = simulatedMines(config({ seed: 'alpha' })).map((mine) => mine.name)
    const b = simulatedMines(config({ seed: 'beta' })).map((mine) => mine.name)
    expect(a).not.toEqual(b)
  })
})

describe('simulatedSnapshots determinism', () => {
  it('produces byte-identical worlds for the same seed and tick', () => {
    const spec = config({ seed: 'repro' })
    expect(worldAt(spec, 5)).toEqual(worldAt(spec, 5))
  })

  it('produces a different world for a different seed', () => {
    expect(worldAt(config({ seed: 'one' }), 5)).not.toEqual(worldAt(config({ seed: 'two' }), 5))
  })

  it('gives every dwarf in the valley a unique id', () => {
    const dwarfs = allDwarfs(worldAt(config(), 3))
    expect(new Set(dwarfs.map((dwarf) => dwarf.id)).size).toBe(dwarfs.length)
  })

  it('reports one snapshot per mine, each carrying that mine as its cwd', () => {
    const spec = config({ mines: 6 })
    const mines = simulatedMines(spec)
    expect(
      worldAt(spec, 0)
        .map((snapshot) => snapshot.cwd)
        .sort()
    ).toEqual(mines.map((mine) => mine.path).sort())
  })

  it('stamps a real wall-clock updatedAt, so recency never reads as 1970', () => {
    for (const snapshot of worldAt(config(), 4)) {
      expect(snapshot.updatedAt).toBeLessThanOrEqual(NOW_MS)
      expect(snapshot.updatedAt).toBeGreaterThan(NOW_MS - 60 * 60 * 1000)
    }
  })

  it('gives every mine exactly one foreman', () => {
    for (const snapshot of worldAt(config(), 2)) {
      const foremen = snapshot.dwarfs.filter((dwarf) => dwarf.role === 'foreman')
      expect(foremen).toHaveLength(1)
    }
  })

  it('mixes both providers, so both sprite sets are exercised', () => {
    const providers = new Set(allDwarfs(worldAt(config(), 1)).map((dwarf) => dwarf.provider))
    expect(providers).toEqual(new Set(['claude', 'codex']))
  })

  it('shows all three dwarf statuses somewhere in the valley', () => {
    const statuses = new Set(allDwarfs(worldAt(config(), 1)).map((dwarf) => dwarf.status))
    expect(statuses).toEqual(new Set(['working', 'waiting', 'leaving']))
  })

  it('gives every dwarf a lastMessage, so speech bubbles actually appear (#43)', () => {
    for (const dwarf of allDwarfs(worldAt(config(), 1))) {
      expect(dwarf.lastMessage).toBeTruthy()
    }
  })
})

describe('simulatedSnapshots showcase mine', () => {
  it('always outnumbers every anchor pool, at every tick and for every seed', () => {
    for (const seed of ['a', 'b', 'c']) {
      for (const tick of [0, 1, 7, 40]) {
        const dwarfs = showcaseDwarfs(config({ seed }), tick)
        const working = dwarfs.filter(
          (dwarf) => dwarf.status === 'working' && dwarf.role === 'worker'
        )
        const waiting = dwarfs.filter((dwarf) => dwarf.status === 'waiting')
        const leaving = dwarfs.filter((dwarf) => dwarf.status === 'leaving')
        const foremen = dwarfs.filter((dwarf) => dwarf.role === 'foreman')
        // Every one of these is the cave-anchor sharing path of #19, and the
        // bubble stagger of #43 that rides on its shareIndex.
        expect(working.length).toBeGreaterThan(VEIN_ANCHORS)
        expect(waiting.length).toBeGreaterThan(REST_ANCHORS)
        expect(foremen.length).toBe(POST_ANCHORS)
        expect(leaving.length).toBeGreaterThan(0)
      }
    }
  })

  it('keeps its whole crew present at every tick, so the crowd never thins out', () => {
    const spec = config({ seed: 'steady' })
    const first = showcaseDwarfs(spec, 0).map((dwarf) => dwarf.id)
    for (const tick of [1, 5, 19]) {
      expect(
        showcaseDwarfs(spec, tick)
          .map((dwarf) => dwarf.id)
          .sort()
      ).toEqual([...first].sort())
    }
  })
})

describe('simulatedSnapshots animation', () => {
  it('churns the crew of ordinary mines over time, so dwarfs arrive and leave', () => {
    const spec = config({ seed: 'churn', animate: true })
    const showcasePath = simulatedMines(spec)[SHOWCASE_MINE_INDEX]!.path
    const idsAt = (tick: number): Set<string> =>
      new Set(
        allDwarfs(worldAt(spec, tick).filter((snapshot) => snapshot.cwd !== showcasePath)).map(
          (dwarf) => dwarf.id
        )
      )
    const early = idsAt(0)
    const later = [1, 2, 3, 4, 5, 6, 7, 8].map(idsAt)
    // Somebody has to have walked out, and somebody has to have walked in.
    expect(later.some((ids) => [...early].some((id) => !ids.has(id)))).toBe(true)
    expect(later.some((ids) => [...ids].some((id) => !early.has(id)))).toBe(true)
  })

  it('freezes the crew and their statuses when animation is off', () => {
    const spec = config({ seed: 'frozen', animate: false })
    const crewAt = (tick: number): string[] =>
      allDwarfs(worldAt(spec, tick))
        .map((dwarf) => `${dwarf.id}/${dwarf.status}/${dwarf.role}`)
        .sort()
    expect(crewAt(9)).toEqual(crewAt(0))
  })

  it('still grows token counters while animation is off, so the vault fills for a screenshot', () => {
    const spec = config({ seed: 'frozen', animate: false })
    const tokensAt = (tick: number): number =>
      allDwarfs(worldAt(spec, tick)).reduce(
        (total, dwarf) => total + (dwarf.tokensObserved ?? 0),
        0
      )
    expect(tokensAt(5)).toBeGreaterThan(tokensAt(0))
  })

  it('never lets the token counter of a surviving dwarf go backwards', () => {
    const spec = config({ seed: 'monotonic' })
    let previous = new Map<string, number>()
    for (let tick = 0; tick < 12; tick++) {
      const current = new Map<string, number>()
      for (const dwarf of allDwarfs(worldAt(spec, tick))) {
        const tokens = dwarf.tokensObserved ?? 0
        const before = previous.get(dwarf.id)
        // A counter that fell would look to the ledger exactly like a session
        // restart and would rebaseline the vault mid-demo.
        if (before !== undefined) expect(tokens).toBeGreaterThanOrEqual(before)
        current.set(dwarf.id, tokens)
      }
      previous = current
    }
  })

  it('accrues enough ore to overflow the 21-nugget pile cap within a few ticks (#22)', () => {
    const spec = config()
    const tokensAt = (tick: number): number =>
      showcaseDwarfs(spec, tick).reduce((total, dwarf) => total + (dwarf.tokensObserved ?? 0), 0)
    // Measured on the showcase mine, whose crew never thins out, so the delta
    // is pure accrual rather than a dwarf having walked off with its counter.
    // 21 nuggets of the DEAREST material is 21 * 250_000 tokens
    // (MATERIAL_TOKENS_PER_UNIT), and the demo has to cross that in seconds
    // rather than in a working week — every cheaper material follows.
    expect(tokensAt(20) - tokensAt(0)).toBeGreaterThan(21 * 250_000)
  })
})
