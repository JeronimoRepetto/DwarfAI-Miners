// The Host's FeatureFlagReader (16 §4.12; 06 §14.2 `FeatureFlags`, INV-110; UC-073). It lives in
// `host/wiring`, the Host place allowed to import `contracts/config` (05 §5.1 R9), and is passed to
// `createPreferences`.
//
// It settles both flags once, when it is created at Host start: the environment, then the userData
// config file (`config-v1.json`, the file UI main reads), then the defaults (both off), through the
// same shared parser UI main uses (`withConfigFileFallback`, `readSwitchText`). `read` answers those
// values for the Host's whole life; a changed file or environment applies at the next start
// (US-GUILD-002.AC03). Unlike UI main, which stops on a bad value, an invalid flag here becomes its
// default with one `warn` record that names the key and never the value (frozen 16 §4.12; a Host
// that refused to start over a hidden flag would stop every session). Only the two flags are read:
// every other setting of the file is UI main's to judge.
import { dirname, join } from 'node:path'
import {
  CONFIG_FILE_NAME,
  FEATURE_FLAG_KEYS,
  parseConfigFileEntries,
  readSwitchText,
  withConfigFileFallback,
  type ConfigEnv,
  type ParsedConfigFile
} from '@dwarfai/contracts'
import type { DiagnosticsLog } from '../kernel/ports/diagnosticsLog'
import type { FileSystem } from '../kernel/ports/fileSystem'
import type { FeatureFlagReader, FeatureFlags } from '../modules/preferences'

/** The record logged once per invalid flag (ADR-026: the key in `causeClass`, never the value). */
export const FEATURE_FLAG_INVALID_EVENT = 'preferences.feature-flag.invalid'

const DEFAULTS: FeatureFlags = { guildAreasEnabled: false, boostEnabled: false }

export interface FeatureFlagSources {
  /** The process environment: `process.env` itself in production, so its keys stay case-insensitive on Windows. */
  env: ConfigEnv
  fs: FileSystem
  /** The userData config file: `featureFlagConfigFilePath(AppPaths.userDataDir)`. */
  configFilePath: string
  log: DiagnosticsLog
}

/**
 * The userData config file UI main reads. The Host's data folder is Electron's userData + `/host`
 * (`AppPaths.userDataDir`, ADR-002 D2), so the file is one folder up.
 */
export function featureFlagConfigFilePath(hostDataDir: string): string {
  return join(dirname(hostDataDir), CONFIG_FILE_NAME)
}

/** Reads the flags once and answers them for the Host's life. */
export async function createFeatureFlagReader(
  sources: FeatureFlagSources
): Promise<FeatureFlagReader> {
  const file = await readConfigFile(sources.fs, sources.configFilePath)
  const layered = withConfigFileFallback(sources.env, file.entries)
  const flagOf = (name: keyof FeatureFlags): boolean => {
    const key = FEATURE_FLAG_KEYS[name]
    const reading = readSwitchText(layered[key])
    // A flag the file holds as a JSON boolean or object is a value no parser reads; under a blank
    // environment it is the file's value, so it counts as invalid rather than as unset.
    const invalid = reading === 'invalid' || (reading === 'unset' && file.ignoredKeys.includes(key))
    if (invalid) {
      sources.log.record({
        level: 'warn',
        event: FEATURE_FLAG_INVALID_EVENT,
        subsystem: 'preferences',
        outcome: 'degraded',
        causeClass: key,
        msg: 'invalid feature flag value; its default applies'
      })
      return DEFAULTS[name]
    }
    return reading === 'unset' ? DEFAULTS[name] : reading
  }
  const flags: FeatureFlags = Object.freeze({
    guildAreasEnabled: flagOf('guildAreasEnabled'),
    boostEnabled: flagOf('boostEnabled')
  })
  return { read: () => ({ ...flags }) }
}

/**
 * The file's settings. No file is the common case, and any other read failure reads the same way, as
 * in UI main (`readUserDataConfigFile`): "nothing configured" is not worth a failed start. A
 * malformed document degrades to no entries (the shared parser's shape rule).
 */
async function readConfigFile(fs: FileSystem, path: string): Promise<ParsedConfigFile> {
  const bytes = await fs.readFile(path)
  if (!bytes.ok) return { entries: {}, ignoredKeys: [] }
  return parseConfigFileEntries(new TextDecoder().decode(bytes.value))
}
