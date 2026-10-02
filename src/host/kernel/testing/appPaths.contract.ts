// The AppPaths conformance suite (16 §2.8, §3 row `AppPaths`; 17 §1.3): run against FakeAppPaths and EnvAppPaths.
// The values are fixed for the Host's life: what it was made with, read the same every time, and never reassigned.
// (A missing DWARFAI_HOST_DATA_DIR refusing the start is the real adapter's own rule, in EnvAppPaths.test.ts.)
import { describe, expect, it } from 'vitest'
import type { AppPaths } from '../ports/appPaths'

/** Makes a subject holding `values` (the real adapter from the Host process facts that yield them). */
export type AppPathsFactory = (values: AppPaths) => AppPaths

const PACKAGED: AppPaths = {
  userDataDir: 'app-data/DwarfAI-Miners/host',
  execPath: 'versions/1.0.0/DwarfAI-Miners',
  resourcesPath: 'versions/1.0.0/resources',
  isPackaged: true
}

const DEV: AppPaths = {
  userDataDir: 'dev-data/DwarfAI-Miners/host',
  execPath: 'node_modules/electron/dist/electron',
  resourcesPath: null,
  isPackaged: false
}

export function runAppPathsContract(make: AppPathsFactory): void {
  describe('AppPaths contract', () => {
    it('[ADR-002] the paths are the values the Host was started with, packaged or not', () => {
      for (const values of [PACKAGED, DEV]) {
        const paths = make(values)

        expect({
          userDataDir: paths.userDataDir,
          execPath: paths.execPath,
          resourcesPath: paths.resourcesPath,
          isPackaged: paths.isPackaged
        }).toEqual(values)
      }
    })

    it('[ADR-002] the values are fixed for the Host life: a reassignment throws and changes nothing', () => {
      const paths = make(PACKAGED)
      const writable = paths as { -readonly [K in keyof AppPaths]: AppPaths[K] }

      expect(() => {
        writable.userDataDir = 'elsewhere'
      }).toThrow(TypeError)
      expect(() => {
        writable.isPackaged = false
      }).toThrow(TypeError)

      expect(paths.userDataDir).toBe(PACKAGED.userDataDir)
      expect(paths.isPackaged).toBe(true)
    })
  })
}
