import { describe, expect, it } from 'vitest'
import { defaultSimulationConfig, type SimulationConfig } from '../../config/config'
import { SimulatedProvider } from './simulatedProvider'
import { simulatedMines, simulatedSnapshots } from './world'

function config(overrides: Partial<SimulationConfig> = {}): SimulationConfig {
  return { ...defaultSimulationConfig(), ...overrides }
}

/** A provider plus the clock handle its tests advance by hand. */
function providerWith(spec: SimulationConfig): {
  provider: SimulatedProvider
  advance: (ms: number) => void
  nowMs: () => number
} {
  let now = 1_700_000_000_000
  const provider = new SimulatedProvider({ config: spec, now: () => now })
  return {
    provider,
    advance: (ms) => {
      now += ms
    },
    nowMs: () => now
  }
}

function expectedWorld(spec: SimulationConfig, tick: number, nowMs: number): unknown {
  return simulatedSnapshots(spec, simulatedMines(spec), tick, nowMs)
}

describe('SimulatedProvider', () => {
  it('reports a real provider kind, so nothing downstream can tell it apart', () => {
    // Cheap to widen since #78 (DWARF_PROVIDERS is one table), and still not
    // widened: the wire contract is what a packaged build publishes, and the
    // renderer has no art for a value only a dev run can produce. Claiming
    // 'claude' keeps the simulation indistinguishable, the whole point of #42.
    expect(new SimulatedProvider({ config: config() }).kind).toBe('claude')
  })

  it('scans the tick the injected clock is on', async () => {
    const spec = config({ seed: 'clock' })
    const { provider, nowMs } = providerWith(spec)
    await expect(provider.scan()).resolves.toEqual(expectedWorld(spec, 0, nowMs()))
  })

  it('stays on one tick until a whole step has passed', async () => {
    const spec = config({ seed: 'clock' })
    const { provider, advance, nowMs } = providerWith(spec)
    await provider.scan()
    advance(spec.stepMs - 1)
    // Same tick, so the same crew doing the same things: only `updatedAt`
    // follows the wall clock, which is what a real quiet provider looks like.
    expect(await provider.scan()).toEqual(expectedWorld(spec, 0, nowMs()))
  })

  it('advances to the next tick once a whole step has passed', async () => {
    const spec = config({ seed: 'clock' })
    const { provider, advance, nowMs } = providerWith(spec)
    const first = await provider.scan()
    advance(spec.stepMs)
    const second = await provider.scan()
    expect(second).not.toEqual(first)
    expect(second).toEqual(expectedWorld(spec, 1, nowMs()))
  })

  it('never walks the clock backwards past tick 0', async () => {
    const spec = config()
    let now = 1_700_000_000_000
    const provider = new SimulatedProvider({ config: spec, now: () => now })
    await provider.scan()
    now -= 60_000
    await expect(provider.scan()).resolves.toEqual(expectedWorld(spec, 0, now))
  })

  it('serves a deterministic transcript feed for a dwarf it has scanned', async () => {
    const { provider } = providerWith(config())
    const dwarfId = (await provider.scan())[0]!.dwarfs[0]!.id
    const feed = await provider.feed(dwarfId, 5)
    expect(feed).toHaveLength(5)
    expect(feed).toEqual(await provider.feed(dwarfId, 5))
    expect(feed!.every((message) => message.text !== '')).toBe(true)
  })

  it('answers null for a dwarf it has never scanned', async () => {
    const { provider } = providerWith(config())
    await provider.scan()
    await expect(provider.feed('claude:not-a-dwarf', 5)).resolves.toBeNull()
  })

  it('exposes no transcript path, because there is no file to tail', async () => {
    const { provider } = providerWith(config())
    const dwarfId = (await provider.scan())[0]!.dwarfs[0]!.id
    expect(provider.transcriptPath(dwarfId)).toBeUndefined()
  })

  it('offers no delivery channel, so the panel never enables an action that cannot work', async () => {
    const { provider } = providerWith(config())
    const dwarfId = (await provider.scan())[0]!.dwarfs[0]!.id
    expect(provider.textDelivery(dwarfId)).toBeNull()
  })
})
