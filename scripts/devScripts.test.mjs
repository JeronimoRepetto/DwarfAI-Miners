import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Electron 42+ ships no `postinstall` script — it downloads its binary lazily
 * on first run of its own `bin` (`npx electron` / `install-electron`), so
 * nothing fetches `node_modules/electron/dist` on `pnpm install` any more.
 * electron-vite 5.0.0 reads `node_modules/electron/path.txt` by hand
 * (`getElectronPath`) and never goes through `require('electron')`, so the
 * lazy download never fires and a fresh checkout's `pnpm dev`/`pnpm preview`
 * dies with "Electron uninstall" (issue #466). `dev` and `preview` must run
 * `install-electron` first so the binary exists before electron-vite looks
 * for it. pnpm 11 still asks about `electron` in `allowBuilds` — it is on
 * pnpm's own default list of packages it treats as native-build risks,
 * independent of whether the package declares a `scripts.postinstall` —
 * so the entry must say `false` explicitly rather than disappear; leaving it
 * unset makes pnpm rewrite the file with an unresolved placeholder on the
 * next install, and `true` would be the stale claim that a build script
 * still runs there.
 */

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function readPackageJson() {
  return JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8'))
}

function readWorkspaceYaml() {
  return readFileSync(path.join(rootDir, 'pnpm-workspace.yaml'), 'utf8')
}

describe('electron lazy-download scripts', () => {
  it('runs install-electron before electron-vite in dev and preview', () => {
    const pkg = readPackageJson()
    expect(pkg.scripts.dev.startsWith('install-electron && ')).toBe(true)
    expect(pkg.scripts.preview.startsWith('install-electron && ')).toBe(true)
  })

  it('marks electron as false rather than true under allowBuilds', () => {
    const yaml = readWorkspaceYaml()
    const allowBuildsBlockMatch = yaml.match(/allowBuilds:\n([\s\S]*?)(?:\n\S|\n*$)/)
    expect(allowBuildsBlockMatch).not.toBeNull()
    const allowBuildsBlock = allowBuildsBlockMatch[1]
    const electronLine = allowBuildsBlock.match(/^\s*electron:\s*(\S+)/m)
    expect(electronLine).not.toBeNull()
    expect(electronLine[1]).toBe('false')
  })
})
