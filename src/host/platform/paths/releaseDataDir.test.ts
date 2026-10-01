import { describe, expect, it } from 'vitest'
import { buildKindOf, releaseHostDataDir } from './releaseDataDir'

// L1 (17 §1.1): the release build's hostDataDir, which the ADR-005 item 6 dev guard compares a
// dev build's database against. Every OS's rule runs on any host (platform passed in). Synthetic
// homes only (privacy-guard).

describe('releaseHostDataDir (ADR-005 item 6, ADR-002 D2)', () => {
  it('[ADR-005, FM-107] the release hostDataDir is the default Electron userData of DwarfAI-Miners plus /host on each OS', () => {
    expect(
      releaseHostDataDir({
        platform: 'win32',
        env: { APPDATA: 'C:\\Users\\j\\AppData\\Roaming' },
        home: 'C:\\Users\\j'
      })
    ).toBe('C:\\Users\\j\\AppData\\Roaming\\DwarfAI-Miners\\host')
    expect(releaseHostDataDir({ platform: 'darwin', env: {}, home: '/Users/j' })).toBe(
      '/Users/j/Library/Application Support/DwarfAI-Miners/host'
    )
    expect(
      releaseHostDataDir({
        platform: 'linux',
        env: { XDG_CONFIG_HOME: '/srv/j/cfg' },
        home: '/home/j'
      })
    ).toBe('/srv/j/cfg/DwarfAI-Miners/host')
  })

  it('[ADR-005, FM-107] without APPDATA or an absolute XDG_CONFIG_HOME the OS default under the home folder applies', () => {
    expect(releaseHostDataDir({ platform: 'win32', env: {}, home: 'C:\\Users\\j' })).toBe(
      'C:\\Users\\j\\AppData\\Roaming\\DwarfAI-Miners\\host'
    )
    for (const XDG_CONFIG_HOME of [undefined, '', 'relative/cfg']) {
      expect(
        releaseHostDataDir({ platform: 'linux', env: { XDG_CONFIG_HOME }, home: '/home/j' }),
        String(XDG_CONFIG_HOME)
      ).toBe('/home/j/.config/DwarfAI-Miners/host')
    }
  })

  it('[ADR-005, FM-107] a packaged Host is a release build and an unpackaged one a dev build', () => {
    expect(buildKindOf({ isPackaged: true })).toBe('release')
    expect(buildKindOf({ isPackaged: false })).toBe('dev')
  })
})
