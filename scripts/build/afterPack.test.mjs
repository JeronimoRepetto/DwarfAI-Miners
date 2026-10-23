// layer: L7
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runAfterPack } from './afterPack.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** A stand-in for electron-builder's packager that logs each fuse call into the shared `log`. */
function loggingPackager(log) {
  return {
    async generateFuseConfig(options) {
      log.push('generateFuseConfig')
      return options
    },
    async addElectronFuses() {
      log.push('addElectronFuses')
    }
  }
}

describe('afterPack: fuses before the Host manifest (ADR-019 item 5; ADR-002 D5)', () => {
  it('[ADR-019, S-019-2] flips the fuses on the packed binary before the Host manifest hashes it, on every OS', async () => {
    for (const electronPlatformName of ['win32', 'darwin', 'linux']) {
      const log = []
      const context = { electronPlatformName, packager: loggingPackager(log) }
      await runAfterPack(context, {
        writeManifest: async (seen) => {
          expect(seen).toBe(context)
          log.push('writeManifest')
        }
      })
      expect(log, electronPlatformName).toEqual([
        'generateFuseConfig',
        'addElectronFuses',
        'writeManifest'
      ])
    }
  })

  it('[ADR-019, S-019-2] the configuration sets no electronFuses, which electron-builder flips after afterPack', () => {
    const { build } = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
    expect(build.afterPack).toBe('scripts/build/afterPack.mjs')
    expect(
      build.electronFuses,
      'electron-builder 26.15 flips `electronFuses` after the afterPack hook, after the manifest is written'
    ).toBeUndefined()
  })
})
