// layer: L7
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { RECORDED_FUSE_SET } from '../release/packaged/fuses.mjs'
import {
  ADR_019_ELECTRON_FUSES,
  flipFusesThenAfterPack
} from '../../spikes/S-019-2/afterPack.fused.mjs'

/**
 * L7 check of the S-019-2 fused build configuration (spikes/S-019-2; ISSUE-328; 17 §4). Run 39134423991: with the set
 * asked of electron-builder's `electronFuses`, electron-builder 26.15 flipped the fuses after the afterPack hook had
 * written `host-manifest.json`, so on macOS and Linux (no afterSign rewrite) the manifest listed the unfused binary and
 * the Host's versioned copy failed with MANIFEST_MISMATCH. The spike now flips the fuses inside its own afterPack hook,
 * before the product's afterPack writes the manifest.
 */
const require = createRequire(import.meta.url)
const config = require('../../spikes/S-019-2/electron-builder.fused.cjs')

const ELECTRON_FUSE_NAMES = {
  runAsNode: 'RunAsNode',
  enableCookieEncryption: 'EnableCookieEncryption',
  enableNodeOptionsEnvironmentVariable: 'EnableNodeOptionsEnvironmentVariable',
  enableNodeCliInspectArguments: 'EnableNodeCliInspectArguments',
  enableEmbeddedAsarIntegrityValidation: 'EnableEmbeddedAsarIntegrityValidation',
  onlyLoadAppFromAsar: 'OnlyLoadAppFromAsar'
}

describe('S-019-2 fused build (ISSUE-328)', () => {
  it('[S-019-2] asks for exactly the fuse set ADR-019 item 5 records', () => {
    const asked = Object.fromEntries(
      Object.entries(ADR_019_ELECTRON_FUSES).map(([key, on]) => [
        ELECTRON_FUSE_NAMES[key],
        on ? 'enabled' : 'disabled'
      ])
    )
    expect(asked).toEqual(RECORDED_FUSE_SET)
  })

  it('[S-019-2] flips the fuses in its afterPack hook, not through electronFuses, which runs after the manifest', () => {
    expect(config.electronFuses).toBeUndefined()
    expect(config.afterPack).toBe('spikes/S-019-2/afterPack.fused.mjs')
    expect(config.directories.output).toBe('release-fused')
  })

  it('[S-019-2] flips the fuses before the product afterPack writes the Host manifest', async () => {
    const calls = []
    const context = {
      packager: {
        generateFuseConfig: async (fuses) => {
          calls.push(['generate', fuses])
          return { generated: fuses }
        },
        addElectronFuses: async (ctx, fuses) => {
          calls.push(['flip', ctx === context, fuses])
        }
      }
    }
    await flipFusesThenAfterPack(context, async (ctx) => {
      calls.push(['afterPack', ctx === context])
    })
    expect(calls).toEqual([
      ['generate', ADR_019_ELECTRON_FUSES],
      ['flip', true, { generated: ADR_019_ELECTRON_FUSES }],
      ['afterPack', true]
    ])
  })
})
