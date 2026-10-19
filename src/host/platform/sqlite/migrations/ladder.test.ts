import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NodeSqliteDatabase } from '../NodeSqliteDatabase'
import { dumpSeededFixture } from '../testing/fixtureDump'
import { readLadder, runRung } from '../testing/fixtureLadder'
import { fixtureSeeds } from '../testing/fixtureSeeds'
import { knownMigrations } from './index'

// L5 (17 §1.5 "From every previous version"; 09 §6.5 "Fixture ladder"; ADR-005 item 6): every
// rung of `fixtures/db/` is built into a temp file, migrated to head by the Host's own runner and
// checked by the data contract. The ladder is never empty: a release that ships without its rung
// fails here instead of passing vacuously.

const LADDER_DIR = join(import.meta.dirname, '..', '..', '..', '..', '..', 'fixtures', 'db')
const HEAD = knownMigrations.at(-1)?.version ?? 0

describe('the fixture ladder (ADR-005 item 6)', () => {
  let work: string

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'dwarfai-ladder-'))
    mkdirSync(join(work, 'ladder'))
    mkdirSync(join(work, 'built'))
  })

  afterEach(() => {
    rmSync(work, { recursive: true, force: true })
  })

  it('[ADR-005] the ladder has at least one rung and every fixtures/db/*.sql rung migrates to head and passes the data contract', () => {
    const ladder = readLadder(LADDER_DIR)

    expect(ladder.problems).toEqual([])
    for (const rung of ladder.rungs) {
      expect(runRung(rung, { workDir: work })).toEqual({
        rung: rung.name,
        outcome: 'migrated',
        version: HEAD,
        problems: []
      })
    }
  })

  it('[ADR-005] every seeded rung equals a fresh dump of its seed, so a regenerated rung is a reviewed diff', () => {
    const ladder = readLadder(LADDER_DIR)
    const seeded = Object.values(fixtureSeeds)

    expect(seeded.map((seed) => `${seed.release}.sql`)).toEqual(
      expect.arrayContaining(ladder.rungs.map((rung) => rung.file))
    )
    for (const seed of seeded) {
      const rung = ladder.rungs.find((candidate) => candidate.name === seed.release)
      // Generic patterns only: the committed text must not depend on the machine running the test.
      expect(rung?.text, `fixtures/db/${seed.release}.sql`).toBe(
        dumpSeededFixture(seed, { identities: [] })
      )
    }
  })

  it('[ADR-005] a rung that is a binary .db file is refused', () => {
    const ladder = join(work, 'ladder')
    const binary = NodeSqliteDatabase.open(join(work, 'source.db'))
    binary.exec(`CREATE TABLE t (x INTEGER) STRICT; VACUUM INTO '${join(ladder, 'cut-9.db')}'`)
    binary.close()
    writeFileSync(join(ladder, 'cut-8.sql'), 'SQLite format 3\u0000 pretending to be text')

    const reading = readLadder(ladder)

    expect(reading.rungs).toEqual([])
    expect(reading.problems).toEqual([
      'cut-8.sql: a rung is SQL text, never a binary SQLite database (17 §1.5)',
      'cut-9.db: a rung is SQL text, never a binary SQLite database (17 §1.5)'
    ])
  })

  it('[ADR-005] a rung whose header version is above head is reported as a future file, not migrated', () => {
    const ladder = join(work, 'ladder')
    const built = join(work, 'built')
    writeFileSync(
      join(ladder, 'cut-99.sql'),
      `-- schema-version: ${HEAD + 1}\nTHIS TEXT IS NEVER EXECUTED;\n`
    )

    const reading = readLadder(ladder)
    expect(reading.problems).toEqual([])
    const outcomes = reading.rungs.map((rung) => runRung(rung, { workDir: built }))

    expect(outcomes).toEqual([
      { rung: 'cut-99', outcome: 'future', version: HEAD + 1, headVersion: HEAD }
    ])
    expect(readdirSync(built)).toEqual([])
  })
})
