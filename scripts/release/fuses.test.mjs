// layer: L7
import { describe, expect, it } from 'vitest'
import {
  electronBuilderFuseOptions,
  expectedFusesFor,
  flipFuses,
  loadExpectedFuses
} from './fuses.mjs'

/** The recorded file with one target's asar integrity marked as a fuse that target cannot flip. */
function withUnflippableAsarIntegrity(doc, target) {
  return {
    ...doc,
    targets: {
      ...doc.targets,
      [target]: {
        knownLimits: [
          {
            fuse: 'EnableEmbeddedAsarIntegrityValidation',
            flipped: false,
            limit: 'this target cannot flip the fuse'
          }
        ]
      }
    }
  }
}

/** A stand-in for electron-builder's packager: records what the fuse step asks of it, in order. */
function recordingPackager() {
  const calls = []
  return {
    calls,
    async generateFuseConfig(options) {
      calls.push(['generateFuseConfig', options])
      return { generatedFrom: options }
    },
    async addElectronFuses(context, config) {
      calls.push(['addElectronFuses', context.electronPlatformName, config])
    }
  }
}

describe('Electron fuses (ADR-019 item 5)', () => {
  it('[ADR-019] the expected fuse set disables Node options and CLI inspect, enables cookie encryption and asar-only loading, and keeps RunAsNode on', () => {
    const { fuses } = loadExpectedFuses()
    expect(fuses).toEqual({
      RunAsNode: 'enabled',
      EnableCookieEncryption: 'enabled',
      EnableNodeOptionsEnvironmentVariable: 'disabled',
      EnableNodeCliInspectArguments: 'disabled',
      EnableEmbeddedAsarIntegrityValidation: 'enabled',
      OnlyLoadAppFromAsar: 'enabled'
    })
  })

  it('[ADR-019, S-019-2] a target whose recorded support lacks asar integrity expects every other fuse and is listed as a known limit', () => {
    const recorded = loadExpectedFuses()
    // S-019-2: Linux flips the fuse (the wire reads it on), but no Linux artifact embeds an integrity record, so P-01
    // still asserts the full set there and the release notes list the limit.
    const linux = expectedFusesFor(recorded, 'linux')
    expect(linux.fuses).toEqual(recorded.fuses)
    expect(linux.knownLimits.map(({ fuse }) => fuse)).toEqual([
      'EnableEmbeddedAsarIntegrityValidation'
    ])
    for (const target of ['win32', 'darwin']) {
      expect(expectedFusesFor(recorded, target)).toEqual({
        fuses: recorded.fuses,
        knownLimits: []
      })
    }

    // A target that cannot flip the fuse at all: every other fuse is still expected, never less.
    const unflippable = expectedFusesFor(withUnflippableAsarIntegrity(recorded, 'linux'), 'linux')
    const everyOther = { ...recorded.fuses }
    delete everyOther.EnableEmbeddedAsarIntegrityValidation
    expect(unflippable.fuses).toEqual(everyOther)
    expect(unflippable.knownLimits).toEqual([
      {
        fuse: 'EnableEmbeddedAsarIntegrityValidation',
        flipped: false,
        limit: 'this target cannot flip the fuse'
      }
    ])
  })

  it('[ADR-019, S-019-2] every target of the three OSes is recorded, and a target with no record fails', () => {
    const recorded = loadExpectedFuses()
    expect(Object.keys(recorded.targets).sort()).toEqual(['darwin', 'linux', 'win32'])
    expect(() => expectedFusesFor(recorded, 'freebsd')).toThrow(/no recorded fuse set for freebsd/)
  })

  it('[ADR-019] the fuse step asks electron-builder for exactly the expected set, in its option names, on the packed app', async () => {
    const packager = recordingPackager()
    const context = { electronPlatformName: 'darwin', appOutDir: 'release/mac-arm64', packager }
    await flipFuses(context)
    const options = {
      runAsNode: true,
      enableCookieEncryption: true,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true
    }
    expect(packager.calls).toEqual([
      ['generateFuseConfig', options],
      ['addElectronFuses', 'darwin', { generatedFrom: options }]
    ])
  })

  it('[ADR-019, S-019-2] the fuse step leaves out a fuse the target cannot flip and flips every other one', () => {
    const doc = withUnflippableAsarIntegrity(loadExpectedFuses(), 'linux')
    expect(electronBuilderFuseOptions(doc, 'linux')).toEqual({
      runAsNode: true,
      enableCookieEncryption: true,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      onlyLoadAppFromAsar: true
    })
    expect(electronBuilderFuseOptions(doc, 'win32')).toHaveProperty(
      'enableEmbeddedAsarIntegrityValidation',
      true
    )
  })
})
