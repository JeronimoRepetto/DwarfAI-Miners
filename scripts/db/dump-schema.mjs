#!/usr/bin/env node
/**
 * dump-schema (17 §1.5 "From empty"; 09 §6.5 "Schema snapshot"): writes
 * `src/host/platform/sqlite/schema.snapshot.sql`, the `sqlite_schema` of an empty file migrated to
 * head by the Host's own runner and migration list, so a later migration that changes the schema
 * updates the snapshot in the same change (22 §5).
 *
 * The migration code is TypeScript loaded through Vite's module runner (the same transform the
 * tests and the build use), never a copy of the SQL, so the snapshot is what the runner builds.
 *
 * The normalised form is `renderSchemaSnapshot` of `src/host/platform/sqlite/testing/
 * schemaSnapshot.ts`, the one the contract test compares with, loaded the same way.
 *
 * Usage: node scripts/db/dump-schema.mjs [--check]
 *   --check  write nothing; exit 1 when the committed snapshot differs from a fresh migration.
 * Exit code 0 on success, 1 on a difference (with --check) or an error.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SQLITE_DIR = path.join(ROOT, 'src', 'host', 'platform', 'sqlite')
const SNAPSHOT_PATH = path.join(SQLITE_DIR, 'schema.snapshot.sql')
const RUNNER_PATH = path.join(SQLITE_DIR, 'migrations', 'runner.ts')
const RENDER_PATH = path.join(SQLITE_DIR, 'testing', 'schemaSnapshot.ts')

/** Migrate an empty temp file with the registered migrations and render its schema. */
async function freshSnapshot() {
  const { runnerImport } = await import('vite')
  const config = { configFile: false, root: ROOT, logLevel: 'error' }
  const { module: runner } = await runnerImport(RUNNER_PATH, config)
  const { module: snapshot } = await runnerImport(RENDER_PATH, config)
  const dir = mkdtempSync(path.join(tmpdir(), 'dwarfai-dump-schema-'))
  try {
    const opened = runner.openHostDb(path.join(dir, 'dwarfai.db'), {
      buildKind: 'test',
      releaseDataDir: path.join(dir, 'release-data'),
      appVersion: 'dump-schema',
      clock: { now: () => 0 }
    })
    if (!opened.ok) throw new Error(`the runner refused an empty file: ${opened.error}`)
    try {
      return snapshot.renderSchemaSnapshot(opened.value.db.all(snapshot.SCHEMA_QUERY))
    } finally {
      opened.value.db.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function main(argv) {
  const check = argv.includes('--check')
  const fresh = await freshSnapshot()
  const relative = path.relative(ROOT, SNAPSHOT_PATH).split(path.sep).join('/')
  if (!check) {
    writeFileSync(SNAPSHOT_PATH, fresh)
    process.stdout.write(`wrote ${relative}\n`)
    return 0
  }
  let committed = ''
  try {
    committed = readFileSync(SNAPSHOT_PATH, 'utf8').replace(/\r\n?/g, '\n')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (committed === fresh) {
    process.stdout.write(`${relative} equals a fresh migration\n`)
    return 0
  }
  process.stderr.write(
    `${relative} differs from a fresh migration; run node scripts/db/dump-schema.mjs and review the diff\n`
  )
  return 1
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exit(1)
    }
  )
}
