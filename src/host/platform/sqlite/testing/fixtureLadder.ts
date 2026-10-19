// The DB fixture ladder (17 §1.5 "From every previous version"; 09 §6.5 "Fixture ladder";
// ADR-005 item 6; 21 §5.1): `fixtures/db/<release>.sql`, one text dump per internal release at
// that release's final schema version, written by `scripts/db/dump-fixture.mjs`. Never imported
// by production code (R14).
//
// - `readLadder` reads the folder as files: every `*.sql` is a rung and must start its text with
//   the `-- schema-version: <n>` header line of `fixtureDump.ts`; `README.md` and `.gitkeep` are
//   the folder's own files; a binary SQLite file (by extension or by its header bytes) is refused,
//   since the ladder is reviewed and privacy-scanned as text; anything else is reported. An empty
//   ladder is itself a problem: the check never passes vacuously.
// - `runRung` builds one rung into a fresh temp file, opens it with the Host's own runner (which
//   migrates it to head) and runs the data contract (`dataContract.ts`). A rung whose version is
//   above head is the future file of ADR-005 item 5: it is reported, never built or migrated.
//   Rungs are read in version order, then by name, so the ladder runs oldest first.
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { RecordingDiagnosticsLog } from '../../../kernel/fakes/RecordingDiagnosticsLog'
import { NodeSqliteDatabase } from '../NodeSqliteDatabase'
import { knownMigrations } from '../migrations/index'
import { openHostDb } from '../migrations/runner'
import type { Migration } from '../migrations/types'
import { checkDataContract } from './dataContract'
import { readSchemaVersionHeader } from './fixtureDump'

export interface LadderRung {
  /** The release the rung belongs to: its file name without `.sql` (`cut-0`). */
  name: string
  /** The rung's file name inside the ladder folder. */
  file: string
  /** The schema version of its header line. */
  version: number
  /** The SQL text, line ends normalised to LF. */
  text: string
}

export interface LadderReading {
  rungs: LadderRung[]
  /** One `<file>: <problem>` line per file that is not a valid rung, or the empty-ladder line. */
  problems: string[]
}

export type RungOutcome =
  | { rung: string; outcome: 'migrated'; version: number; problems: string[] }
  | { rung: string; outcome: 'future'; version: number; headVersion: number }
  | { rung: string; outcome: 'refused'; error: string }

export interface RunRungOptions {
  /** Where the rung's temp database is built; the caller removes it. */
  workDir: string
  /** The build's migrations (head is the last one); the registered list by default. */
  migrations?: readonly Migration[]
}

/** The ladder folder's own files, never rungs. */
const FOLDER_FILES = new Set(['README.md', '.gitkeep'])
const SQLITE_EXTENSION = /\.(?:db|sqlite3?)$/i
/** The first 16 bytes of every SQLite database file (sqlite.org/fileformat.html §1.3). */
const SQLITE_HEADER = Buffer.from('SQLite format 3\u0000', 'latin1')
const BINARY_PROBLEM = 'a rung is SQL text, never a binary SQLite database (17 §1.5)'

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Read the rungs of the ladder folder `dir` and report every file that is not one. */
export function readLadder(dir: string): LadderReading {
  const rungs: LadderRung[] = []
  const problems: string[] = []
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort(compareText)
  for (const file of files) {
    if (FOLDER_FILES.has(file)) continue
    const bytes = readFileSync(join(dir, file))
    if (
      SQLITE_EXTENSION.test(file) ||
      bytes.subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER)
    ) {
      problems.push(`${file}: ${BINARY_PROBLEM}`)
      continue
    }
    if (!file.endsWith('.sql')) {
      problems.push(`${file}: only <release>.sql rungs, README.md and .gitkeep sit in the ladder`)
      continue
    }
    const text = bytes.toString('utf8').replace(/\r\n?/g, '\n')
    const version = readSchemaVersionHeader(text)
    if (version === null) {
      problems.push(`${file}: the rung has no "-- schema-version: <n>" header line`)
      continue
    }
    rungs.push({ name: file.slice(0, -'.sql'.length), file, version, text })
  }
  if (rungs.length === 0 && problems.length === 0) {
    problems.push(
      'the ladder has no rung: every internal release commits fixtures/db/<release>.sql'
    )
  }
  rungs.sort((a, b) => a.version - b.version || compareText(a.name, b.name))
  return { rungs, problems }
}

/** Build `rung` into a temp file, migrate it to head and run the data contract. */
export function runRung(rung: LadderRung, options: RunRungOptions): RungOutcome {
  const migrations = options.migrations ?? knownMigrations
  const headVersion = migrations.at(-1)?.version ?? 0
  if (rung.version > headVersion) {
    return { rung: rung.name, outcome: 'future', version: rung.version, headVersion }
  }
  const dir = join(options.workDir, rung.name)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const path = join(dir, 'dwarfai.db')
  const builder = NodeSqliteDatabase.open(path)
  try {
    builder.exec(rung.text)
  } finally {
    builder.close()
  }
  const opened = openHostDb(path, {
    buildKind: 'test',
    releaseDataDir: join(dir, 'release-data'),
    appVersion: 'fixture-ladder',
    clock: { now: () => 0 },
    log: new RecordingDiagnosticsLog(),
    migrations
  })
  if (!opened.ok) return { rung: rung.name, outcome: 'refused', error: opened.error }
  try {
    if (opened.value.readOnly) {
      return { rung: rung.name, outcome: 'refused', error: 'opened read-only' }
    }
    return {
      rung: rung.name,
      outcome: 'migrated',
      version: opened.value.version,
      problems: checkDataContract(opened.value.db)
    }
  } finally {
    opened.value.db.close()
  }
}
