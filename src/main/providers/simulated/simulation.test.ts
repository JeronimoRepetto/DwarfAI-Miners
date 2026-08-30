import { describe, expect, it, vi } from 'vitest'
import { SIMULATION_ENV_VAR } from '../../config/config'
import { createSimulation } from './simulation'

const ON = { [SIMULATION_ENV_VAR]: '1' }

describe('createSimulation gate', () => {
  it('is off when nothing asks for it', () => {
    expect(createSimulation({ env: {}, isPackaged: false })).toBeNull()
  })

  it('turns on for an unpackaged build that explicitly asks', () => {
    expect(createSimulation({ env: ON, isPackaged: false })).not.toBeNull()
  })

  it.each([['0'], ['false'], ['off'], ['yes'], ['']])(
    'stays off for the non-affirmative value %j',
    (value) => {
      expect(
        createSimulation({ env: { [SIMULATION_ENV_VAR]: value }, isPackaged: false })
      ).toBeNull()
    }
  )

  it('refuses to run in a packaged build even when the environment asks for it', () => {
    // The load-bearing guarantee of #42: a user must never see invented mines.
    // app.isPackaged is derived by Electron from the running executable, so a
    // packaged build cannot set it false however its environment is arranged.
    expect(createSimulation({ env: ON, isPackaged: true })).toBeNull()
  })

  it('says out loud that it refused a packaged build, rather than failing silently', () => {
    const warn = vi.fn()
    createSimulation({ env: ON, isPackaged: true, warn })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain(SIMULATION_ENV_VAR)
  })

  it('stays quiet in a packaged build that never asked', () => {
    const warn = vi.fn()
    createSimulation({ env: {}, isPackaged: true, warn })
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('createSimulation tier authority', () => {
  it('answers the invented tier for an invented mine path', async () => {
    const simulation = createSimulation({ env: ON, isPackaged: false })!
    const snapshots = await simulation.provider.scan()
    const tiers = new Set(snapshots.map((snapshot) => simulation.tierOf(snapshot.cwd)))
    // A real TierService would walk these paths, find nothing, and call every
    // invented mine bronze — which would hide the tier spread the demo exists
    // to show. The simulation therefore owns its own tier answers.
    expect(tiers.size).toBeGreaterThan(1)
  })

  it('reports every invented tier as already measured, so the vault accrues at once', async () => {
    const simulation = createSimulation({ env: ON, isPackaged: false })!
    for (const snapshot of await simulation.provider.scan()) {
      expect(simulation.knownTierOf(snapshot.cwd)).toBe(simulation.tierOf(snapshot.cwd))
    }
  })

  it('falls back to bronze for a path it never invented', () => {
    const simulation = createSimulation({ env: ON, isPackaged: false })!
    expect(simulation.tierOf('C:\\Users\\j\\real-project')).toBe('bronze')
    expect(simulation.knownTierOf('C:\\Users\\j\\real-project')).toBeUndefined()
  })
})
