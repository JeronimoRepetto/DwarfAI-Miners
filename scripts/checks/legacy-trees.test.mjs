// layer: L7
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * L7 static check of the cut-5 legacy-area deletions (21 §2 cut 5; ADR-001 items 4–5; ADR-029): each deleted area holds
 * no file, no source outside it imports it, and no preserved-invariant test referenced by an `invariants.test.ts` lives
 * in it. One case pair per legacy area, added by the issue that deletes it (ISSUE-245, ISSUE-331 … ISSUE-341). Every
 * source file is read as text; nothing of the product is imported.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
/** This file's own samples, and those of the legacy-importers check, are text, not imports. */
const SAMPLE_FILES = new Set([
  'scripts/checks/legacy-trees.test.mjs',
  'scripts/checks/legacy-importers.test.mjs'
])

/** Roots that hold code; generated output and dependencies are not walked. The canaries import deleted files on purpose. */
const ROOTS = ['src', 'e2e', 'scripts', 'perf', 'fixtures', 'spikes', 'testing']
const SKIPPED_DIRS = new Set(['node_modules', 'out', 'dist', '.git'])
const CODE_FILE = /\.(ts|tsx|mts|cts|js|mjs|cjs|vue)$/
/** `from '…'`, `import '…'`, `import('…')`, `require('…')`, `vi.mock('…')` and `export … from '…'`. */
const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*|\bvi\.mock\s*\(\s*)['"]([^'"\n]+)['"]/g

function filesUnder(relativeDir, keep = () => true) {
  const absolute = path.join(repoRoot, relativeDir)
  if (!existsSync(absolute)) return []
  return readdirSync(absolute).flatMap((name) => {
    const relative = `${relativeDir}/${name}`
    if (statSync(path.join(repoRoot, relative)).isDirectory()) {
      return SKIPPED_DIRS.has(name) ? [] : filesUnder(relative, keep)
    }
    return keep(name) ? [relative] : []
  })
}

function codeFiles() {
  const top = readdirSync(repoRoot).filter(
    (name) => CODE_FILE.test(name) && statSync(path.join(repoRoot, name)).isFile()
  )
  return [...ROOTS.flatMap((root) => filesUnder(root, (name) => CODE_FILE.test(name))), ...top]
}

function inside(file, dir) {
  return file === dir || file.startsWith(`${dir}/`)
}

/** Each relative import of `file` that lands in `dir`, as `<file> -> <target>`. */
function importsInto(file, text, dir) {
  const found = []
  for (const match of text.matchAll(SPECIFIER)) {
    const specifier = match[1]
    if (!specifier.startsWith('.')) continue
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier))
    if (inside(target, dir)) found.push(`${file} -> ${target}`)
  }
  return found
}

/** The files left under `dir`, and every import of `dir` from a source outside it. */
function areaState(dir) {
  const left = filesUnder(dir)
  const importers = codeFiles()
    .filter((file) => !SAMPLE_FILES.has(file) && !inside(file, dir))
    .flatMap((file) => importsInto(file, readFileSync(path.join(repoRoot, file), 'utf8'), dir))
  return { left, importers }
}

/** Every repository path an `invariants.test.ts` names that lies in `dir`. */
function invariantReferencesInto(dir) {
  const indexes = filesUnder('src', (name) => name === 'invariants.test.ts')
  expect(indexes.length, 'no invariants.test.ts index found').toBeGreaterThan(0)
  return indexes.flatMap((index) => {
    const text = readFileSync(path.join(repoRoot, index), 'utf8')
    return [...text.matchAll(/['"`](src\/[^'"`\s]+)['"`]/g)]
      .map((match) => match[1])
      .filter((reference) => inside(reference, dir))
      .map((reference) => `${index} -> ${reference}`)
  })
}

function expectAreaGone(dirs) {
  for (const dir of dirs) {
    const { left, importers } = areaState(dir)
    expect(left, `${dir} still holds files`).toEqual([])
    expect(importers, `sources outside ${dir} import it`).toEqual([])
  }
}

/** The ISSUE-341 area: the last folders under src/main. */
const LAST_MAIN_FOLDERS = ['src/main/domain', 'src/main/config', 'src/main/runtime']

function expectNoInvariantIn(dirs) {
  for (const dir of dirs) expect(invariantReferencesInto(dir)).toEqual([])
}

describe('legacy trees removed (21 §2 cut 5)', () => {
  it('[ADR-001] the import reader resolves relative specifiers into an area and ignores its siblings', () => {
    const text = [
      "import { a } from '../../main/jev/routeDecision'",
      "vi.mock('../../main/jev/capabilities/claude')",
      "import { b } from '../../main/jevish/other'",
      "const c = await import('../../contracts/index.ts')"
    ].join('\n')
    expect(importsInto('src/host/x/y.ts', text, 'src/main/jev')).toEqual([
      'src/host/x/y.ts -> src/main/jev/routeDecision',
      'src/host/x/y.ts -> src/main/jev/capabilities/claude'
    ])
  })

  it('[ADR-001] src/main/jev holds no file and no source outside it imports it', () => {
    expectAreaGone(['src/main/jev'])
  })

  it('[ADR-029] no preserved-invariant test referenced by invariants.test.ts lives in src/main/jev', () => {
    expectNoInvariantIn(['src/main/jev'])
  })

  it('[ADR-001] src/main/notifications holds no file and no source outside it imports it', () => {
    expectAreaGone(['src/main/notifications'])
  })

  it('[ADR-029] no preserved-invariant test referenced by invariants.test.ts lives in src/main/notifications', () => {
    expectNoInvariantIn(['src/main/notifications'])
  })

  it('[ADR-001] src/main/shell holds no file and no source outside it imports it', () => {
    expectAreaGone(['src/main/shell'])
  })

  it('[ADR-029] no preserved-invariant test referenced by invariants.test.ts lives in src/main/shell', () => {
    expectNoInvariantIn(['src/main/shell'])
  })

  it('[ADR-001] src/main/ledger holds no file and no source outside it imports it', () => {
    expectAreaGone(['src/main/ledger'])
  })

  it('[ADR-029] no preserved-invariant test referenced by invariants.test.ts lives in src/main/ledger', () => {
    expectNoInvariantIn(['src/main/ledger'])
  })

  it('[ADR-001] src/main/projects, src/main/history hold no file and no source outside them imports them', () => {
    expectAreaGone(['src/main/projects', 'src/main/history'])
  })

  it('[ADR-029] no preserved-invariant test referenced by invariants.test.ts lives in src/main/projects, src/main/history', () => {
    expectNoInvariantIn(['src/main/projects', 'src/main/history'])
  })

  it('[ADR-001] src/main/mcp holds no file and no source outside it imports it', () => {
    expectAreaGone(['src/main/mcp'])
  })

  it('[ADR-029] no preserved-invariant test referenced by invariants.test.ts lives in src/main/mcp', () => {
    expectNoInvariantIn(['src/main/mcp'])
  })

  it('[ADR-001] the standalone jevMcpServer build is gone: no config, no package script, no unpacked output', () => {
    expect(existsSync(path.join(repoRoot, 'electron.vite.jevMcpServer.config.ts'))).toBe(false)
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
    expect(JSON.stringify(pkg.scripts)).not.toMatch(/jevMcpServer|build:mcp-server/)
    expect(pkg.build.asarUnpack).not.toContain('out/main/jevMcpServer.mjs')
  })

  it('[ADR-001] src/main/providers holds no file and no source outside it imports it', () => {
    expectAreaGone(['src/main/providers'])
  })

  it('[ADR-029] no preserved-invariant test referenced by invariants.test.ts lives in src/main/providers', () => {
    expectNoInvariantIn(['src/main/providers'])
  })

  it('[ADR-001] src/main/sessionLaunch holds no file and no source outside it imports it', () => {
    expectAreaGone(['src/main/sessionLaunch'])
  })

  it('[ADR-029] no preserved-invariant test referenced by invariants.test.ts lives in src/main/sessionLaunch', () => {
    expectNoInvariantIn(['src/main/sessionLaunch'])
  })

  it('[ADR-001] src/main/textDelivery holds no file and no source outside it imports it', () => {
    expectAreaGone(['src/main/textDelivery'])
  })

  it('[ADR-029] no preserved-invariant test referenced by invariants.test.ts lives in src/main/textDelivery', () => {
    expectNoInvariantIn(['src/main/textDelivery'])
  })

  it('[ADR-001] src/main/hooks, src/main/opencodePermissions hold no file and no source outside them imports them', () => {
    expectAreaGone(['src/main/hooks', 'src/main/opencodePermissions'])
  })

  it('[ADR-029] no preserved-invariant test referenced by invariants.test.ts lives in src/main/hooks, src/main/opencodePermissions', () => {
    expectNoInvariantIn(['src/main/hooks', 'src/main/opencodePermissions'])
  })

  it('[ADR-001] src/main/tier holds no file and no source outside it imports it', () => {
    expectAreaGone(['src/main/tier'])
  })

  it('[ADR-029] no preserved-invariant test referenced by invariants.test.ts lives in src/main/tier', () => {
    expectNoInvariantIn(['src/main/tier'])
  })

  // src/main/config is the ISSUE-341 area, but it was the last importer of src/main/tier, so it left with tier (D1).
  it('[ADR-001] src/main/config, the importer src/main/tier stranded, holds no file and no source outside it imports it', () => {
    expectAreaGone(['src/main/config'])
  })

  it('[ADR-001] src/main/platform, src/main/adapters hold no file and no source outside them imports them', () => {
    expectAreaGone(['src/main/platform', 'src/main/adapters'])
  })

  it('[ADR-029] no preserved-invariant test referenced by invariants.test.ts lives in src/main/platform, src/main/adapters', () => {
    expectNoInvariantIn(['src/main/platform', 'src/main/adapters'])
  })

  // ISSUE-341: the last src/main folders, then src/main itself.
  it('[ADR-001] src/main/domain, src/main/config, src/main/runtime hold no file and no source outside them imports them', () => {
    expectAreaGone(LAST_MAIN_FOLDERS)
  })

  it('[ADR-029] no preserved-invariant test referenced by invariants.test.ts lives in src/main/domain, src/main/config, src/main/runtime', () => {
    expectNoInvariantIn(LAST_MAIN_FOLDERS)
  })

  it('[ADR-001] src/main holds no file', () => {
    expectAreaGone(['src/main'])
  })

  it('[ADR-029] every preserved-invariant test referenced by invariants.test.ts lives outside src/main', () => {
    expectNoInvariantIn(['src/main'])
  })
})

/**
 * The pure src/shared modules ISSUE-011 re-homed in src/contracts/text, each with the number of test statements its
 * src/shared test file held when ISSUE-246 deleted it (05 §2.1 `contracts/text/`).
 */
const SHARED_REHOMED = {
  accelerator: 38,
  consoleText: 15,
  dwarfName: 56,
  externalLink: 5,
  heldSessionText: 2,
  truncate: 15
}

/** The `it` / `test` statements of a test file, counted as the census counts them. */
function statementCount(text) {
  return [...text.matchAll(/^\s*(?:it|test)(?:\.\w+)*\(/gm)].length
}

describe('src/shared re-homed (21 §2 cut 5)', () => {
  it('[ADR-001] no file under src imports src/shared', () => {
    expect(areaState('src/shared').importers).toEqual([])
  })

  it('[R9] every src/shared module of the re-home list has its twin in src/contracts/text with a test file of at least the same statement count', () => {
    for (const [module, statements] of Object.entries(SHARED_REHOMED)) {
      expect(existsSync(path.join(repoRoot, 'src/contracts/text', `${module}.ts`)), module).toBe(
        true
      )
      const testFile = path.join(repoRoot, 'src/contracts/text', `${module}.test.ts`)
      expect(existsSync(testFile), `${module}.test.ts`).toBe(true)
      expect(statementCount(readFileSync(testFile, 'utf8')), module).toBeGreaterThanOrEqual(
        statements
      )
    }
  })

  it('[ADR-001] src/shared holds no file', () => {
    expect(filesUnder('src/shared')).toEqual([])
  })
})
