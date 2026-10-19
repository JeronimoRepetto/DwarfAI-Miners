// layer: L1
import { describe, expect, it } from 'vitest'
import { DEV_DATA_DIR_NAME, uiDataDirectory } from './dataDirectory'

// L1 (17 §1.1): which folder the rebuilt UI and its Host keep their data in (ADR-005 item 6; 09 §1; ADR-002 D2;
// FM-107). A packaged build keeps Electron's userData. A development or preview build, which is unpackaged, never
// uses the release folder: Electron would name it after the product (`DwarfAI-Miners`), so that build moves to its
// own `DwarfAI-dev` beside it. A userData chosen on the command line (`--user-data-dir`, the E2E and OS-lane temp
// profiles) is no release folder and is kept.

describe('uiDataDirectory (ADR-005 item 6)', () => {
  it('[ADR-005, FM-107] a development build whose userData is the release folder uses DwarfAI-dev beside it', () => {
    expect(
      uiDataDirectory({
        platform: 'win32',
        isPackaged: false,
        appData: 'C:\\Users\\j\\AppData\\Roaming',
        userData: 'C:\\Users\\j\\AppData\\Roaming\\DwarfAI-Miners'
      })
    ).toBe('C:\\Users\\j\\AppData\\Roaming\\DwarfAI-dev')
    expect(
      uiDataDirectory({
        platform: 'darwin',
        isPackaged: false,
        appData: '/Users/j/Library/Application Support',
        userData: '/Users/j/Library/Application Support/DwarfAI-Miners'
      })
    ).toBe('/Users/j/Library/Application Support/DwarfAI-dev')
    expect(
      uiDataDirectory({
        platform: 'linux',
        isPackaged: false,
        appData: '/home/j/.config',
        userData: '/home/j/.config/DwarfAI-Miners'
      })
    ).toBe('/home/j/.config/DwarfAI-dev')
    expect(DEV_DATA_DIR_NAME).toBe('DwarfAI-dev')
  })

  it('[ADR-005, FM-107] the release folder is recognised the way the OS compares paths: case and a trailing separator on Windows, case on macOS', () => {
    expect(
      uiDataDirectory({
        platform: 'win32',
        isPackaged: false,
        appData: 'C:\\Users\\j\\AppData\\Roaming',
        userData: 'c:\\users\\J\\appdata\\roaming\\dwarfai-miners\\'
      })
    ).toBe('C:\\Users\\j\\AppData\\Roaming\\DwarfAI-dev')
    expect(
      uiDataDirectory({
        platform: 'darwin',
        isPackaged: false,
        appData: '/Users/j/Library/Application Support',
        userData: '/Users/j/Library/Application Support/dwarfai-miners'
      })
    ).toBe('/Users/j/Library/Application Support/DwarfAI-dev')
    // Linux folders are case-sensitive: another folder, kept as it is.
    expect(
      uiDataDirectory({
        platform: 'linux',
        isPackaged: false,
        appData: '/home/j/.config',
        userData: '/home/j/.config/dwarfai-miners'
      })
    ).toBe('/home/j/.config/dwarfai-miners')
  })

  it('[ADR-005, ADR-002] a packaged build keeps its userData, the release folder', () => {
    expect(
      uiDataDirectory({
        platform: 'win32',
        isPackaged: true,
        appData: 'C:\\Users\\j\\AppData\\Roaming',
        userData: 'C:\\Users\\j\\AppData\\Roaming\\DwarfAI-Miners'
      })
    ).toBe('C:\\Users\\j\\AppData\\Roaming\\DwarfAI-Miners')
  })

  it('[ADR-005, ADR-002] a development build with a userData of its own (an E2E or OS-lane temp profile) keeps it', () => {
    expect(
      uiDataDirectory({
        platform: 'win32',
        isPackaged: false,
        appData: 'C:\\Users\\j\\AppData\\Roaming',
        userData: 'C:\\Users\\j\\AppData\\Local\\Temp\\dwarfai-e2e-a1b2c3\\userData'
      })
    ).toBe('C:\\Users\\j\\AppData\\Local\\Temp\\dwarfai-e2e-a1b2c3\\userData')
    expect(
      uiDataDirectory({
        platform: 'linux',
        isPackaged: false,
        appData: '/home/j/.config',
        userData: '/tmp/dwarfai-e2e-a1b2c3/userData'
      })
    ).toBe('/tmp/dwarfai-e2e-a1b2c3/userData')
  })
})
