// layer: L7
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import appConfig from '../../electron.vite.config'

/**
 * The app's Electron entry from cut 0 (ISSUE-056; 21 §2 cut 0 "Retired at the end"; TC-056-04): `package.json` `main`
 * names the output of the app build's `main` target, and that target is the UI-main composition root. The legacy entry
 * `src/main/index.ts` stays in the tree but is no longer built; today's runtime is reached only through
 * `LegacyRuntimeRoute` (R16, lint).
 */
const REPO_ROOT = resolve(import.meta.dirname, '..', '..')

describe('the app entry (21 §2 cut 0)', () => {
  it('[R16] the Electron main entry is the UI-main composition root, built by the app build into out/ui-main', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as {
      main: string
      scripts: Record<string, string>
    }
    expect(pkg.main).toBe('./out/ui-main/index.js')
    expect(appConfig.main?.build?.outDir).toBe('out/ui-main')
    expect(appConfig.main?.build?.rollupOptions?.input).toEqual({
      index: resolve(REPO_ROOT, 'src/ui-main/index.ts')
    })
    // One build of the entry: no second config builds it, and `pnpm build` runs the app build first.
    const build = pkg.scripts.build ?? ''
    expect(build).not.toContain('electron.vite.uiMain.config.ts')
    expect(build.startsWith('electron-vite build &&')).toBe(true)
  })
})
