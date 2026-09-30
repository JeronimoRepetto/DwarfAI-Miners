// layer: L7
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveEntry } from '../../e2e/_harness/resolveEntry.ts'

/**
 * L7 check of the E2E harness entry choice (testing strategy `17` §1.9; ISSUE-312 review R8B-02).
 *
 * `launchApp({ entry })` starts either the build's Electron main entry (`'current'`, the default:
 * `package.json` `main`) or the output of the UI-main composition root's build target
 * (`'ui-main'`), which exists in the build before the cut-0 switch makes it the app's entry. A
 * build without that output is refused with a clear message, never silently replaced by the
 * current entry.
 */

let tempRoots = []

afterEach(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true })
  tempRoots = []
})

/** A temporary app folder holding the given build outputs (repository-relative posix paths). */
function appWith(outputs) {
  const appDir = mkdtempSync(path.join(tmpdir(), 'e2e-entry-'))
  tempRoots.push(appDir)
  for (const relative of outputs) {
    const file = path.join(appDir, relative)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, '')
  }
  return appDir
}

const MAIN = './out/main/index.js'

describe('E2E harness entry (17 §1.9)', () => {
  it('[ADR-001] resolveEntry picks the Electron main entry by default and the ui-main target output for entry ui-main', () => {
    const appDir = appWith(['out/main/index.js', 'out/ui-main/index.js'])

    expect(resolveEntry(undefined, appDir, { main: MAIN })).toBe(
      path.join(appDir, 'out', 'main', 'index.js')
    )
    expect(resolveEntry('current', appDir, { main: MAIN })).toBe(
      path.join(appDir, 'out', 'main', 'index.js')
    )
    expect(resolveEntry('ui-main', appDir, { main: MAIN })).toBe(
      path.join(appDir, 'out', 'ui-main', 'index.js')
    )
    // After the cut-0 switch `main` names the ui-main output, and both values start the same entry.
    expect(resolveEntry('current', appDir, { main: './out/ui-main/index.js' })).toBe(
      resolveEntry('ui-main', appDir, { main: './out/ui-main/index.js' })
    )
  })

  it('[ADR-001] resolveEntry refuses entry ui-main with a clear error when the build has no ui-main output', () => {
    const appDir = appWith(['out/main/index.js'])

    expect(() => resolveEntry('ui-main', appDir, { main: MAIN })).toThrow(
      /no ui-main output.*out[\\/]ui-main[\\/]index\.js/
    )
    expect(() => resolveEntry('current', appWith([]), { main: MAIN })).toThrow(
      /no Electron main entry.*pnpm build/
    )
  })
})
