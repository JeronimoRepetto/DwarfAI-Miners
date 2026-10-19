import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import type { SqliteDatabase } from '../../kernel/ports/sqliteDatabase'
import { migrationsFor } from './migrations/index'
import { openHostDb } from './migrations/runner'
import { constraintInventory, type SchemaConstraint } from './testing/constraintInventory'

// L5 (17 §1.5; ISSUE-036): every constraint of the migrated schema is proven both ways by
// `schema.contract.test.ts`. A probe there is a `T(tag, …)` (must store) or an `R(tag, …)` (must be
// rejected) whose first argument is a string literal, so the probe list is read from the source;
// a later migration that adds a constraint without both probes fails here with its tag.

const MIGRATION_SQL = readFileSync(
  new URL('./migrations/0001-initial.sql', import.meta.url),
  'utf8'
).replace(/\r\n?/g, '\n')
const PROBE_SOURCE = readFileSync(new URL('./schema.contract.test.ts', import.meta.url), 'utf8')

type ProbeKind = 'stores' | 'rejected'

interface ProbeCall {
  readonly kind: ProbeKind
  readonly tag: string | null
}

/**
 * Every `T(` / `R(` call of the probe file, with its literal tag (`null` when not a literal).
 * Comment lines and blocks are left out: they name the helpers without calling them.
 */
function probeCalls(file: string): ProbeCall[] {
  const source = file.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const calls: ProbeCall[] = []
  const call = /(?<![\w$.])(?<!function )([TR])\(\s*/g
  for (let match = call.exec(source); match !== null; match = call.exec(source)) {
    const kind: ProbeKind = match[1] === 'T' ? 'stores' : 'rejected'
    const rest = source.slice(call.lastIndex)
    const literal = /^(['"])((?:\\.|(?!\1)[^\\\n])*)\1\s*,/.exec(rest)
    calls.push({
      kind,
      tag: literal === null ? null : (literal[2] ?? '').replace(/\\(.)/g, '$1')
    })
  }
  return calls
}

function uncovered(inventory: readonly SchemaConstraint[], calls: readonly ProbeCall[]): string[] {
  const has = (tag: string, kind: ProbeKind): boolean =>
    calls.some((call) => call.tag === tag && call.kind === kind)
  return inventory.flatMap(({ tag }) => [
    ...(has(tag, 'stores') ? [] : [`${tag} — no stores probe`]),
    ...(has(tag, 'rejected') ? [] : [`${tag} — no rejected probe`])
  ])
}

describe('schema contract coverage (17 §1.5)', () => {
  let dir: string
  let db: SqliteDatabase
  let inventory: SchemaConstraint[]

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dwarfai-coverage-'))
    const clock = new FakeClock(1_750_000_000_000)
    const opened = openHostDb(join(dir, 'dwarfai.db'), {
      buildKind: 'test',
      releaseDataDir: join(dir, 'release-data'),
      appVersion: '0.0.0-test',
      clock,
      migrations: migrationsFor({ clock, ids: new SequenceIdGenerator() }),
      log: new RecordingDiagnosticsLog()
    })
    if (!opened.ok) throw new Error(`expected the open to succeed, got ${opened.error}`)
    db = opened.value.db
    inventory = constraintInventory(db)
  })

  afterAll(async () => {
    db.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('[ADR-005] the constraint inventory lists every trigger, foreign key and UNIQUE of the migrated schema, with no tag twice', () => {
    const count = (kind: SchemaConstraint['kind']): number =>
      inventory.filter((constraint) => constraint.kind === kind).length
    // A UNIQUE index, a UNIQUE (…) clause and a column UNIQUE each write the keyword once.
    const declared = (pattern: RegExp): number =>
      MIGRATION_SQL.replace(/--[^\n]*/g, '').match(pattern)?.length ?? 0

    expect(count('trigger')).toBe(declared(/^CREATE TRIGGER /gm))
    expect(count('fk')).toBe(declared(/\bREFERENCES\b/g))
    expect(count('unique')).toBe(declared(/\bUNIQUE\b/g))
    expect(count('check')).toBeGreaterThan(0)
    expect(new Set(inventory.map(({ tag }) => tag)).size).toBe(inventory.length)
  })

  it('[ADR-005] every CHECK, UNIQUE, trigger and FK action of the migrated schema has at least one stores probe and one rejected probe', () => {
    const calls = probeCalls(PROBE_SOURCE)
    const known = new Set(inventory.map(({ tag }) => tag))

    expect(calls.filter((call) => call.tag === null)).toEqual([])
    expect(
      calls.filter((call) => call.tag !== null && !known.has(call.tag)).map((call) => call.tag)
    ).toEqual([])
    expect(uncovered(inventory, calls)).toEqual([])
  })
})
