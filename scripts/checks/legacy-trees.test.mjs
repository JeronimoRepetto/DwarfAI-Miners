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
/** This file's own samples are text, not imports. */
const SELF = 'scripts/checks/legacy-trees.test.mjs'

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
    .filter((file) => file !== SELF && !inside(file, dir))
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

  // ISSUE-332 is partial: src/main/sessionLaunch (the D1 import cycle) still imports these three modules, so they
  // leave with that group; this list only shrinks.
  it('[ADR-001] src/main/mcp holds only the modules src/main/sessionLaunch still imports, and their tests', () => {
    expect(filesUnder('src/main/mcp').sort()).toEqual([
      'src/main/mcp/delegationInjection.ts',
      'src/main/mcp/delegationLink.test.ts',
      'src/main/mcp/delegationLink.ts',
      'src/main/mcp/delegationProtocol.test.ts',
      'src/main/mcp/delegationProtocol.ts'
    ])
    const outside = areaState('src/main/mcp').importers.filter(
      (line) => !line.startsWith('src/main/sessionLaunch/')
    )
    expect(outside).toEqual([])
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
})
