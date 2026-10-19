// The FeatureFlagReader double (16 §4.12, 16 §2.8). An L2 test builds it with the flags it wants and
// may change them later (`set`), standing in for an environment or a file that changed after start;
// `fromLayers` settles the flags once from layers, as the `host/wiring` reader does. A port's double
// may not import `contracts` (R9), so it restates the switch rule, and the shared contract
// (runFeatureFlagReaderContract) holds it equal to the real reader. Never imported by production
// code (R14).
import type { FeatureFlagReader, FeatureFlags } from '../featureFlagReader'

const DEFAULTS: FeatureFlags = { guildAreasEnabled: false, boostEnabled: false }

export class FakeFeatureFlagReader implements FeatureFlagReader {
  /** The keys named by invalid-value warnings, in order. */
  readonly warnedKeys: string[] = []
  /** How many times `read` was called. */
  reads = 0
  private flags: FeatureFlags

  constructor(flags: Partial<FeatureFlags> = {}) {
    this.flags = { ...DEFAULTS, ...flags }
  }

  /** The flags settled once from `layers`: the environment, then the file, then the defaults. */
  static fromLayers(layers: {
    env: Record<string, string | undefined>
    file: Record<string, string> | null
  }): FakeFeatureFlagReader {
    const reader = new FakeFeatureFlagReader()
    const flagOf = (key: string): boolean => {
      const fromEnv = layers.env[key]
      const raw = fromEnv !== undefined && fromEnv.trim() !== '' ? fromEnv : layers.file?.[key]
      if (raw === undefined || raw.trim() === '') return false
      const normalized = raw.trim().toLowerCase()
      if (normalized === 'true' || normalized === '1') return true
      if (normalized === 'false' || normalized === '0') return false
      reader.warnedKeys.push(key)
      return false
    }
    reader.flags = {
      guildAreasEnabled: flagOf('GUILD_AREAS_ENABLED'),
      boostEnabled: flagOf('BOOST_ENABLED')
    }
    return reader
  }

  /** What the next `read` answers: a test's stand-in for a changed environment or file. */
  set(flags: Partial<FeatureFlags>): void {
    this.flags = { ...this.flags, ...flags }
  }

  read(): FeatureFlags {
    this.reads += 1
    return { ...this.flags }
  }
}
