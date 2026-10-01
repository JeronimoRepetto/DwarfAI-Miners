// layer: L2
import { describe, expect, it } from 'vitest'
import type { ConfigEnv } from '@dwarfai/contracts'
import { createAppInfo } from './appInfo'

/**
 * The build info and the feature flags UI main answers (14 §2.1 A-28 `getAppBuild`, A-29 `getFeatureFlags`): the
 * build from the build metadata, the flags from the pure config parser of `contracts/config` (R9) over the layers
 * environment → the userData config file → defaults, read once when UI main starts.
 */

function configFile(entries: Record<string, string> | null) {
  const reader = {
    reads: 0,
    read: (): string | null => {
      reader.reads += 1
      return entries === null ? null : JSON.stringify(entries)
    }
  }
  return reader
}

const BUILD = { version: '2.4.1', packaged: true }

function flagsOf(env: ConfigEnv, entries: Record<string, string> | null) {
  return createAppInfo({
    build: BUILD,
    env,
    readConfigFile: configFile(entries).read
  }).featureFlags()
}

describe('app info (14 §2.1 A-28, A-29)', () => {
  it('[ADR-019] getFeatureFlags reads env, then the userData config, then defaults, once at start', () => {
    // The environment wins over the file.
    expect(flagsOf({ GUILD_AREAS_ENABLED: 'true' }, { GUILD_AREAS_ENABLED: 'false' })).toEqual({
      guildAreasEnabled: true
    })
    expect(flagsOf({ GUILD_AREAS_ENABLED: '0' }, { GUILD_AREAS_ENABLED: 'true' })).toEqual({
      guildAreasEnabled: false
    })
    // An unset or blank variable falls through to the file.
    expect(flagsOf({}, { GUILD_AREAS_ENABLED: 'true' })).toEqual({ guildAreasEnabled: true })
    expect(flagsOf({ GUILD_AREAS_ENABLED: '  ' }, { GUILD_AREAS_ENABLED: '1' })).toEqual({
      guildAreasEnabled: true
    })
    // Neither: the default, hidden.
    expect(flagsOf({}, null)).toEqual({ guildAreasEnabled: false })
    expect(flagsOf({}, {})).toEqual({ guildAreasEnabled: false })

    // Once at start: the file is read when UI main starts, and later changes to either layer change nothing.
    const env: ConfigEnv = {}
    const file = configFile({ GUILD_AREAS_ENABLED: 'true' })
    const info = createAppInfo({ build: BUILD, env, readConfigFile: file.read })
    expect(file.reads).toBe(1)
    env.GUILD_AREAS_ENABLED = 'false'
    expect(info.featureFlags()).toEqual({ guildAreasEnabled: true })
    expect(info.featureFlags()).toEqual({ guildAreasEnabled: true })
    expect(file.reads).toBe(1)
  })

  it('[ADR-033] getAppBuild answers the build metadata in today’s shape', () => {
    const info = createAppInfo({ build: BUILD, env: {}, readConfigFile: () => null })
    expect(info.build()).toEqual({ version: '2.4.1', packaged: true })
  })

  it('[ADR-019] a corrupt userData config file degrades to the defaults', () => {
    const info = createAppInfo({ build: BUILD, env: {}, readConfigFile: () => '{not json' })
    expect(info.featureFlags()).toEqual({ guildAreasEnabled: false })
  })
})
