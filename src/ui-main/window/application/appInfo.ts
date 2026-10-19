// The build info and the feature flags UI main answers (14 §2.1 A-28 `getAppBuild`, A-29 `getFeatureFlags`; both
// KEEP, `ui-local`, owner `window`), in today's shapes taken from the channel registry. The flags come from the pure
// config parser of `contracts/config` (ADR-004 P5, R9) over its layers, most specific first: the environment, then
// the userData config file, then the defaults. Both are read once, when UI main starts, as today's runtime does. The
// Host's version is not here: it is in `getHostConnection` (A-N03), and the Host reads its own flags (ISSUE-211).
import type { z } from 'zod'
import {
  loadConfig,
  parseConfigFileEntries,
  withConfigFileFallback,
  type CHANNELS,
  type ConfigEnv
} from '@dwarfai/contracts'

export type AppBuild = z.infer<(typeof CHANNELS)['app:build']['response']>
export type FeatureFlags = z.infer<(typeof CHANNELS)['app:features']['response']>

export interface AppInfoSources {
  /** The build metadata: Electron's app version and whether this is a packaged build. */
  build: AppBuild
  /** The process environment (on Windows, `process.env` itself, so its keys stay case-insensitive). */
  env: ConfigEnv
  /** The text of the userData config file (`CONFIG_FILE_NAME`), or `null` when there is none to read. */
  readConfigFile(): string | null
}

export interface AppInfo {
  build(): AppBuild
  featureFlags(): FeatureFlags
}

/**
 * Reads both answers once. A config file that is not a JSON object of settings degrades to no entries (the parser's
 * shape rule); a setting whose value is wrong fails fast with the parser's own message, as it fails today's startup.
 * `boostEnabled` is not exposed until it is designed (14 §8 I-07).
 */
export function createAppInfo(sources: AppInfoSources): AppInfo {
  const build: AppBuild = { version: sources.build.version, packaged: sources.build.packaged }
  const raw = sources.readConfigFile()
  const entries = raw === null ? {} : parseConfigFileEntries(raw).entries
  const config = loadConfig(withConfigFileFallback(sources.env, entries))
  const flags: FeatureFlags = { guildAreasEnabled: config.guildAreasEnabled }
  return {
    build: () => ({ ...build }),
    featureFlags: () => ({ ...flags })
  }
}
