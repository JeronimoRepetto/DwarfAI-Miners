#!/usr/bin/env node
/**
 * dump-fixture (17 §1.5 "From every previous version", §1.4 "Redaction (scrub rules)"; 09 §6.5
 * "Fixture ladder"; ADR-005 item 6; 21 §5.1): writes `fixtures/db/<release>.sql`, the DB fixture
 * ladder rung of one internal release. It migrates an empty in-memory database with the Host's own
 * runner up to the release's final schema version, runs the release's representative rows (the
 * seeds of `src/host/platform/sqlite/testing/fixtureSeeds.ts`) and dumps the database as SQL text:
 * a `-- schema-version` header, the schema, the rows as INSERTs in foreign-key order, scrubbed.
 *
 * The migration, seed and dump code is TypeScript loaded through Vite's module runner (the same
 * transform the tests and the build use), exactly as `dump-schema.mjs` does, so the rung is what
 * the runner builds and what the ladder test regenerates.
 *
 * Scrubbing replaces this machine's home directory, account name and host name, any `Users`/`home`
 * directory path, e-mail addresses and secret shapes (17 §1.4). Read the written file before
 * committing it (skill `privacy-guard`).
 *
 * Usage: node scripts/db/dump-fixture.mjs --seed <release> [--check]
 *   --seed <release>  the seed to dump (`cut-0`); the rung is fixtures/db/<release>.sql.
 *   --check           write nothing; exit 1 when the committed rung differs from a fresh dump.
 * Exit code 0 on success, 1 on a difference (with --check) or an error.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir, hostname, userInfo } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const TESTING_DIR = path.join(ROOT, 'src', 'host', 'platform', 'sqlite', 'testing')
const DUMP_PATH = path.join(TESTING_DIR, 'fixtureDump.ts')
const SEEDS_PATH = path.join(TESTING_DIR, 'fixtureSeeds.ts')
const LADDER_DIR = path.join(ROOT, 'fixtures', 'db')

/** This machine's home directory, account name and host name: what a dump must never contain. */
export function localIdentity() {
  let user = ''
  try {
    user = userInfo().username
  } catch {
    // No account name to read (a container without a passwd entry): nothing to scrub for it.
  }
  return { home: homedir(), user, host: hostname() }
}

function parseArgs(argv) {
  const at = argv.indexOf('--seed')
  const release = at >= 0 ? argv[at + 1] : undefined
  if (release === undefined || release.startsWith('--')) {
    throw new Error('usage: node scripts/db/dump-fixture.mjs --seed <release> [--check]')
  }
  return { release, check: argv.includes('--check') }
}

async function freshRung(release) {
  const { runnerImport } = await import('vite')
  const config = { configFile: false, root: ROOT, logLevel: 'error' }
  const { module: dump } = await runnerImport(DUMP_PATH, config)
  const { module: seeds } = await runnerImport(SEEDS_PATH, config)
  const seed = seeds.fixtureSeeds[release]
  if (seed === undefined) {
    throw new Error(
      `no seed named ${release}; known: ${Object.keys(seeds.fixtureSeeds).join(', ')}`
    )
  }
  return dump.dumpSeededFixture(seed, { identities: [localIdentity()] })
}

async function main(argv) {
  const { release, check } = parseArgs(argv)
  const fresh = await freshRung(release)
  const target = path.join(LADDER_DIR, `${release}.sql`)
  const relative = path.relative(ROOT, target).split(path.sep).join('/')
  if (!check) {
    writeFileSync(target, fresh)
    process.stdout.write(`wrote ${relative}; read it before committing it (privacy-guard)\n`)
    return 0
  }
  let committed = ''
  try {
    committed = readFileSync(target, 'utf8').replace(/\r\n?/g, '\n')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (committed === fresh) {
    process.stdout.write(`${relative} equals a fresh dump of its seed\n`)
    return 0
  }
  process.stderr.write(
    `${relative} differs from a fresh dump of its seed; run node scripts/db/dump-fixture.mjs --seed ${release} and review the diff\n`
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
