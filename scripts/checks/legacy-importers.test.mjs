// layer: L7
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * L7 static check that nothing outside the legacy trees reaches into them (05 §5.1 R16, R8; 21 §2 cut 5): only
 * `src/main/**`, `src/shared/**` and `src/legacy-bridge/**` may import `src/main/**` or `src/shared/**`, so the cut-5
 * deletions can remove both trees whole. Every source file is read as text; nothing of the product is imported.
 *
 * depcruise R16 covers the new roots only; this check also covers the renderer, the e2e suites and the scripts, which
 * the legacy exclusion and the per-config lint scopes leave out.
 *
 * `legacy-importers.baseline.json` names the importers still allowed, each with the issue that removes it. It only
 * shrinks: an entry that no longer imports a legacy tree fails here until it is deleted from the list.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
/** This file's own samples below are text, not imports. */
const SELF = 'scripts/checks/legacy-importers.test.mjs'

/** The trees that may import legacy code: the legacy trees themselves and the one bridge (ADR-004 P12). */
const LEGACY_SIDE = /^src\/(main|shared|legacy-bridge)\//
/** The trees no one else may import. */
const LEGACY_TREE = /^src\/(main|shared)(\/|$)/

/** Roots that hold code; generated output and dependencies are not walked. */
const ROOTS = ['src', 'e2e', 'scripts', 'perf', 'fixtures', 'spikes', 'lint-canaries']
const SKIPPED_DIRS = new Set(['node_modules', 'out', 'dist', '.git'])
const CODE_FILE = /\.(ts|tsx|mts|cts|js|mjs|cjs|vue)$/

/** `from '…'`, `import '…'`, `import('…')`, `require('…')` and `export … from '…'`. */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"]([^'"\n]+)['"]/g

function codeFiles(relativeDir) {
  const absolute = path.join(repoRoot, relativeDir)
  if (!existsSync(absolute)) return []
  return readdirSync(absolute).flatMap((name) => {
    const relative = `${relativeDir}/${name}`
    if (statSync(path.join(repoRoot, relative)).isDirectory()) {
      return SKIPPED_DIRS.has(name) ? [] : codeFiles(relative)
    }
    return CODE_FILE.test(name) ? [relative] : []
  })
}

/** Top-level config files (vite, vitest, playwright, eslint …) beside the roots. */
function rootFiles() {
  return readdirSync(repoRoot).filter(
    (name) => CODE_FILE.test(name) && statSync(path.join(repoRoot, name)).isFile()
  )
}

/** Each relative import of `file` that lands in a legacy tree, as `<file> -> <target>`. */
function legacyImportsOf(file, text) {
  const found = []
  for (const match of text.matchAll(SPECIFIER)) {
    const specifier = match[1]
    if (!specifier.startsWith('.')) continue
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier))
    if (LEGACY_TREE.test(target)) found.push(`${file} -> ${target}`)
  }
  return found
}

function legacyImporters() {
  const files = [...ROOTS.flatMap(codeFiles), ...rootFiles()]
  return files
    .filter((file) => file !== SELF && !LEGACY_SIDE.test(file))
    .flatMap((file) => legacyImportsOf(file, readFileSync(path.join(repoRoot, file), 'utf8')))
}

function baseline() {
  return JSON.parse(readFileSync(path.join(here, 'legacy-importers.baseline.json'), 'utf8'))
}

describe('legacy importers (05 §5.1 R16)', () => {
  it('[ADR-001] the import reader resolves relative specifiers of .ts and .vue files into the legacy trees', () => {
    const vue = [
      '<script setup lang="ts">',
      "import { x } from '../../../../shared/dwarfName'",
      "import type { Y } from '../../types'",
      '</script>'
    ].join('\n')
    expect(legacyImportsOf('src/renderer/src/components/a/B.vue', vue)).toEqual([
      'src/renderer/src/components/a/B.vue -> src/shared/dwarfName'
    ])
    const e2e = [
      "import { a } from '../../src/main/sample/area.ts'",
      "const b = await import('../../src/contracts/index.ts')",
      "export { c } from '../_harness/launchApp.ts'"
    ].join('\n')
    expect(legacyImportsOf('e2e/cut-0/x.ts', e2e)).toEqual([
      'e2e/cut-0/x.ts -> src/main/sample/area.ts'
    ])
    // A folder merely named `shared` elsewhere is not the legacy tree.
    expect(
      legacyImportsOf('src/host/modules/m/a.ts', "import { d } from './shared/childEnv'")
    ).toEqual([])
  })

  it('[ADR-001] no file outside src/main, src/shared and src/legacy-bridge imports src/main or src/shared, except the baseline', () => {
    const allowed = new Set(baseline().map((entry) => entry.file))
    const offenders = legacyImporters().filter((line) => !allowed.has(line.split(' -> ')[0]))
    expect(offenders).toEqual([])
  })

  it('[ADR-001] every baseline entry still imports a legacy tree and names the issue that removes it', () => {
    const importers = new Set(legacyImporters().map((line) => line.split(' -> ')[0]))
    for (const entry of baseline()) {
      expect(entry.removedBy, `${entry.file} names no issue`).toMatch(/^ISSUE-\d{3}$/)
      expect(
        importers.has(entry.file),
        `${entry.file} no longer imports legacy code: drop it`
      ).toBe(true)
    }
  })
})
