import { loadSimulationConfig, SIMULATION_ENV_VAR, type ConfigEnv } from '../../config'
import type { MineTier } from '../../domain/types'
import { currentPlatform, normalizePathKey, type Platform } from '../../platform/platform'
import type { Provider } from '../provider'
import { SimulatedProvider } from './simulatedProvider'
import { simulatedMines } from './world'

/**
 * The switch, and the lock on it (issue #42).
 *
 * A user must never see invented mines. #38 gave a packaged, installed app a
 * real config file it reads on every launch, so "an ordinary setting" is no
 * longer a safe way to gate anything a user must not reach — whatever is
 * expressible in that file is expressible on a stranger's machine.
 *
 * So the gate is two locks that fail independently:
 *
 *  1. The signal is a REAL environment variable, read by `loadSimulationConfig`
 *     from `process.env` and never from the config-file-layered map (see the
 *     long comment in config.ts). The userData config file cannot carry it.
 *
 *  2. This function refuses outright when the build is packaged. `isPackaged`
 *     comes from Electron's own `app.isPackaged`, which Electron derives from
 *     the running executable — a packaged build cannot set it false however its
 *     environment, config file or command line is arranged. This is the lock
 *     that actually protects the user; lock 1 only keeps the switch tidy.
 *
 * The second lock is checked here rather than at the call site so that there is
 * exactly one place in the codebase where a simulation can come into existence,
 * and it is a place that cannot be reached without passing the packaging flag.
 */

/**
 * A running simulation: the provider, plus the tier answers that go with it.
 *
 * The tier lookups travel with the provider because the real `TierService`
 * would walk these paths, find nothing on disk, and report every invented mine
 * as bronze — flattening the tier spread the demo exists to show and starving
 * the vault of every material but one. A simulated valley has to be the
 * authority on its own geology.
 */
export interface Simulation {
  provider: Provider
  /** What the map draws the mound as; the poller's `tierOf`. */
  tierOf: (path: string) => MineTier
  /** What the vault is allowed to accrue as; the ledger's confirmed-tier lookup (#41). */
  knownTierOf: (path: string) => MineTier | undefined
}

export interface CreateSimulationOptions {
  /** The REAL process environment. Never a config-file-layered map. */
  env?: ConfigEnv
  /** Electron's own `app.isPackaged`. True disables the simulation unconditionally. */
  isPackaged: boolean
  /** Injected for tests; shared with the runtime so ticks and the grace window agree. */
  now?: () => number
  /** Where the packaged-build refusal is reported; defaults to swallowing it. */
  warn?: (message: string) => void
  /** Decides how paths are compared; defaults to this machine's platform. */
  platform?: Platform
}

export function createSimulation(options: CreateSimulationOptions): Simulation | null {
  const config = loadSimulationConfig(options.env)
  if (config === null) return null

  if (options.isPackaged) {
    // Loud rather than silent: reaching here means an installed app was
    // launched with a development switch set, which is worth knowing about
    // even though the answer is simply no.
    options.warn?.(
      `[simulation] Ignoring ${SIMULATION_ENV_VAR}: the simulated provider is a ` +
        'development tool and never runs in a packaged build.'
    )
    return null
  }

  const platform = options.platform ?? currentPlatform()
  const tiers = new Map<string, MineTier>(
    simulatedMines(config).map((mine) => [normalizePathKey(mine.path, platform), mine.tier])
  )
  // Keyed the way aggregateMines keys mines, so a lookup matches whatever
  // separator and case the path reached the runtime with.
  const lookup = (path: string): MineTier | undefined => tiers.get(normalizePathKey(path, platform))

  return {
    provider: new SimulatedProvider({ config, now: options.now }),
    // A path this simulation never invented is a real project that slipped
    // through; bronze is the same provisional answer TierService would give.
    tierOf: (path) => lookup(path) ?? 'bronze',
    // Every invented tier counts as already measured: there is no walk to wait
    // for, so making the vault wait (#41) would just mean an empty vault.
    knownTierOf: (path) => lookup(path)
  }
}
