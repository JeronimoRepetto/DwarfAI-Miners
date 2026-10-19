// layer: L7
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { findLegacyDbReferences, formatFinding, runNoLegacyDb } from './no-legacy-db.mjs'

/**
 * L7 static check that no code opens today's database, ledger or marker file (21 §5.3; ADR-005 item 1; NFR-PERS-15;
 * ISSUE-244). The check reads `src/` as text; the seeded case runs it on a per-test temporary tree.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

let tempRoots = []

afterEach(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true })
  tempRoots = []
})

function seededTree(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'no-legacy-db-'))
  tempRoots.push(root)
  for (const [relative, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true })
    writeFileSync(path.join(root, relative), text)
  }
  return root
}

describe('no legacy database access (21 §5.3)', () => {
  it('[ADR-005, NFR-PERS-15] no file under src names projects-v1.db or imports appDatabase, except the foreign-file test fixture of the Host migrations', () => {
    const findings = findLegacyDbReferences(repoRoot).filter(
      ({ kind }) => kind === 'legacy-database' || kind === 'app-database-import'
    )
    expect(findings.map(formatFinding)).toEqual([])
  })

  it('[ADR-005] a seeded tree with a new projects-v1.db reference is reported with its file and line', () => {
    const root = seededTree({
      'src/host/x/opensLegacy.ts': [
        "import { join } from 'node:path'",
        '// projects-v1.db is foreign: a comment line is no code',
        "export const legacy = join('userData', 'projects-v1.db')"
      ].join('\n'),
      'src/ui-main/y/importsLegacy.ts':
        "import { openAppDatabase } from '../../main/appDatabase/appDatabase'\n",
      'src/host/platform/sqlite/migrations/runner.test.ts': "const legacy = 'projects-v1.db'\n"
    })
    expect(findLegacyDbReferences(root).map(formatFinding)).toEqual([
      "src/host/x/opensLegacy.ts:3: legacy-database: export const legacy = join('userData', 'projects-v1.db')",
      "src/ui-main/y/importsLegacy.ts:1: app-database-import: import { openAppDatabase } from '../../main/appDatabase/appDatabase'"
    ])
    const lines = { out: [], err: [] }
    const exit = runNoLegacyDb([root], {
      out: (line) => lines.out.push(line),
      err: (line) => lines.err.push(line)
    })
    expect(exit).toBe(1)
    expect(lines.err[0]).toBe(
      "no-legacy-db: src/host/x/opensLegacy.ts:3: legacy-database: export const legacy = join('userData', 'projects-v1.db')"
    )
  })

  it('[NFR-PERS-15] no file under src reads the legacy JSON ledger or the coal-backfill marker file', () => {
    const findings = findLegacyDbReferences(repoRoot).filter(
      ({ kind }) => kind === 'legacy-ledger' || kind === 'legacy-marker'
    )
    expect(findings.map(formatFinding)).toEqual([])
    // The check recognizes both names (its own positive case).
    const root = seededTree({
      'src/x.ts': "read('material-ledger-v1.json')\nread('coal-backfill-v1.json')\n"
    })
    expect(findLegacyDbReferences(root).map(({ kind }) => kind)).toEqual([
      'legacy-ledger',
      'legacy-marker'
    ])
  })
})
