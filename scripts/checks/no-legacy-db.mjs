#!/usr/bin/env node
/**
 * No legacy database access (migration plan `21` §5.3; ADR-005 item 1; NFR-PERS-15; ISSUE-244).
 *
 * After cut 5 no code of DwarfAI opens, reads, imports, converts or deletes today's `projects-v1.db`, the legacy JSON
 * ledger (`material-ledger-v1.json`) or the coal-backfill marker file (`coal-backfill-v1.json`): the files stay on the
 * person's disk untouched. This check reads every source file under `src/` as text and reports each code line that
 * names one of those files or imports today's `appDatabase` module, with its file and line, so such a path cannot come
 * back. Comment lines are not code and are skipped: the Host's migrations explain in prose why a legacy file is
 * foreign.
 *
 * Usage: node scripts/checks/no-legacy-db.mjs [<repository root>]
 * Exit code 0 when nothing is found, 1 with one line per finding on stderr otherwise.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** The legacy files no code may name (21 §5.3), with the finding kind each one reports. */
export const LEGACY_FILES = [
  { name: 'projects-v1.db', kind: 'legacy-database' },
  { name: 'material-ledger-v1.json', kind: 'legacy-ledger' },
  { name: 'coal-backfill-v1.json', kind: 'legacy-marker' }
]

/**
 * The foreign-file test of the Host migrations (ISSUE-034, `09` §6.5) builds a file shaped like `projects-v1.db` to
 * prove the Host refuses it and leaves it byte-identical; it is the one place allowed to name it.
 */
export const ALLOWED_FILES = new Set(['src/host/platform/sqlite/migrations/runner.test.ts'])

const SKIPPED_DIRS = new Set(['node_modules', 'out', 'dist', '.git'])
const CODE_FILE = /\.(ts|tsx|mts|cts|js|mjs|cjs|vue)$/
/** `from '…'`, `import '…'`, `import('…')`, `require('…')`, `vi.mock('…')` and `export … from '…'`. */
const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*|\bvi\.mock\s*\(\s*)['"]([^'"\n]+)['"]/g
/** Today's app database module, by folder or by file, with or without an extension. */
const APP_DATABASE_SPECIFIER = /(^|\/)appDatabase(\/appDatabase)?(\.[cm]?[jt]s)?$/
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*)/

function filesUnder(root, relativeDir) {
  const absolute = path.join(root, relativeDir)
  if (!existsSync(absolute)) return []
  return readdirSync(absolute).flatMap((name) => {
    const relative = `${relativeDir}/${name}`
    if (statSync(path.join(root, relative)).isDirectory()) {
      return SKIPPED_DIRS.has(name) ? [] : filesUnder(root, relative)
    }
    return CODE_FILE.test(name) ? [relative] : []
  })
}

/** The findings of one file's text, each `{ file, line, kind, text }`. */
export function scanText(file, text) {
  const findings = []
  text.split(/\r?\n/).forEach((line, index) => {
    if (COMMENT_LINE.test(line)) return
    for (const { name, kind } of LEGACY_FILES) {
      if (line.includes(name)) findings.push({ file, line: index + 1, kind, text: line.trim() })
    }
    for (const match of line.matchAll(SPECIFIER)) {
      if (APP_DATABASE_SPECIFIER.test(match[1])) {
        findings.push({ file, line: index + 1, kind: 'app-database-import', text: line.trim() })
      }
    }
  })
  return findings
}

/** Every finding under `src/` of the repository at `root`, the allowed foreign-file test excluded. */
export function findLegacyDbReferences(root) {
  return filesUnder(root, 'src')
    .filter((file) => !ALLOWED_FILES.has(file))
    .flatMap((file) => scanText(file, readFileSync(path.join(root, file), 'utf8')))
}

/** One finding as the command line prints it. */
export function formatFinding({ file, line, kind, text }) {
  return `${file}:${line}: ${kind}: ${text}`
}

/** Runs the check as the command line does; returns the exit code. */
export function runNoLegacyDb(argv, io) {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const root = path.resolve(argv[0] ?? path.join(here, '..', '..'))
  const findings = findLegacyDbReferences(root)
  if (findings.length > 0) {
    for (const finding of findings) io.err(`no-legacy-db: ${formatFinding(finding)}`)
    io.err(
      `no-legacy-db: ${findings.length} legacy database reference(s) under src (21 §5.3, NFR-PERS-15)`
    )
    return 1
  }
  io.out('no-legacy-db: no code under src names or opens a legacy database, ledger or marker file')
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runNoLegacyDb(process.argv.slice(2), {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`)
  })
}
