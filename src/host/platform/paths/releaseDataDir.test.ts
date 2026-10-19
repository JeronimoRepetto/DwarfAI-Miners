import { describe, expect, it } from 'vitest'
import { buildKindOf, hostLogDir, releaseHostDataDir } from './releaseDataDir'

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

describe('hostLogDir (ADR-026 item 1, 19 §3)', () => {
  it('[ADR-026] the Host logs into <userData>/logs, beside the hostDataDir the UI handed it', () => {
    expect(
      hostLogDir({
        platform: 'win32',
        env: {},
        home: 'C:\\Users\\j',
        isPackaged: true,
        hostDataDir: 'D:\\profiles\\e2e-7\\host'
      })
    ).toBe('D:\\profiles\\e2e-7\\logs')
    expect(
      hostLogDir({
        platform: 'linux',
        env: {},
        home: '/home/j',
        isPackaged: false,
        hostDataDir: '/tmp/e2e-7/host'
      })
    ).toBe('/tmp/e2e-7/logs')
  })

  it('[ADR-026, ADR-002] without DWARFAI_HOST_DATA_DIR a packaged Host logs into the fixed 19 §3 folder of each OS', () => {
    const packaged = { isPackaged: true, hostDataDir: null }
    expect(
      hostLogDir({
        ...packaged,
        platform: 'win32',
        env: { APPDATA: 'C:\\Users\\j\\AppData\\Roaming' },
        home: 'C:\\Users\\j'
      })
    ).toBe('C:\\Users\\j\\AppData\\Roaming\\DwarfAI-Miners\\logs')
    expect(hostLogDir({ ...packaged, platform: 'darwin', env: {}, home: '/Users/j' })).toBe(
      '/Users/j/Library/Application Support/DwarfAI-Miners/logs'
    )
    expect(hostLogDir({ ...packaged, platform: 'linux', env: {}, home: '/home/j' })).toBe(
      '/home/j/.config/DwarfAI-Miners/logs'
    )
  })

  it('[ADR-005, ADR-026] without DWARFAI_HOST_DATA_DIR a dev Host logs into DwarfAI-dev, never into the release log folder', () => {
    const dev = { isPackaged: false, hostDataDir: null }
    expect(
      hostLogDir({
        ...dev,
        platform: 'win32',
        env: { APPDATA: 'C:\\Users\\j\\AppData\\Roaming' },
        home: 'C:\\Users\\j'
      })
    ).toBe('C:\\Users\\j\\AppData\\Roaming\\DwarfAI-dev\\logs')
    expect(hostLogDir({ ...dev, platform: 'linux', env: {}, home: '/home/j' })).toBe(
      '/home/j/.config/DwarfAI-dev/logs'
    )
  })
})
