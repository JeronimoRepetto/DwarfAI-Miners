// layer: L5
// L5 (17 §1.5): the attention module's `ResetDbStep` (16 §4.12) over a copy of the template
// database, the 09 §6.5 "Reset scope" probe for the attention tables (09 §7.2 rows
// `attention_keys`, `attention_announced`: "kept for open asks of present dwarfs; others deleted
// (turn keys, suppressed or emitted, included)"). L7 (17 §1.7): the module reaches the saga
// structurally, with no import of `preferences` (05 §1.3, R4).
//
// TC-118-01.
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HostInvariantError } from '../../../kernel/domain/errors'
import type { SqliteDatabase } from '../../../kernel/ports/sqliteDatabase'
import { SqliteTransactionRunner } from '../../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../../platform/sqlite/testing/templateDb'
import { AttentionResetStep } from './sqlite/AttentionResetStep'

const T0 = 1_790_000_000_000
const MINE = '00000000-0000-7000-8000-0000000118f1'
/** Present, with an open question and an answering permission ask. */
const PRESENT = '00000000-0000-7000-8000-0000000118d1'
/** Present, with a closed question ask and an open permission ask. */
const OTHER = '00000000-0000-7000-8000-0000000118d2'
/** Departed, its open question ask still on file. */
const DEPARTED = '00000000-0000-7000-8000-0000000118d3'

const ASK = {
  presentOpenQuestion: '00000000-0000-7000-8000-0000000118a1',
  presentAnsweringPermission: '00000000-0000-7000-8000-0000000118a2',
  otherClosedQuestion: '00000000-0000-7000-8000-0000000118a3',
  otherOpenPermission: '00000000-0000-7000-8000-0000000118a4',
  departedOpenQuestion: '00000000-0000-7000-8000-0000000118a5'
} as const

const KEY = {
  presentOpenQuestion: `${PRESENT}:question:${ASK.presentOpenQuestion}`,
  presentAnsweringPermission: `${PRESENT}:permission:${ASK.presentAnsweringPermission}`,
  presentWithdrawnTurn: `${PRESENT}:turn-finished:turn-1`,
  otherSuppressedTurn: `${OTHER}:turn-finished:turn-2`,
  otherClosedQuestion: `${OTHER}:question:${ASK.otherClosedQuestion}`,
  departedOpenQuestion: `${DEPARTED}:question:${ASK.departedOpenQuestion}`
} as const

/**
 * The seeded probe: a present dwarf's emitted key of an open ask and suppressed key of an answering
 * ask, its withdrawn turn-finished key, another present dwarf's suppressed turn key and the key of
 * its closed ask, a departed dwarf's key of an ask still open, and carry-over rows of each.
 */
function seeded() {
  const { db } = openTemplateCopy()
  const runner = new SqliteTransactionRunner(db)
  runner.inTransaction(() => {
    db.run(
      `INSERT INTO mines (id, canonical_path, name, name_norm, state, created_at, last_used_at)
       VALUES (?, '/work/mine-one', 'mine-one', 'mine-one', 'active', ?, ?)`,
      [MINE, T0, T0]
    )
    ;[PRESENT, OTHER, DEPARTED].forEach((id, n) => {
      const departed = id === DEPARTED
      db.run(
        `INSERT INTO dwarfs (id, mine_id, provider_id, provider_session_id, base_name, rank,
           process_state, turn_state, arrived_at, last_activity_at, departed_at, departure_cause)
         VALUES (?, ?, 'claude', ?, 'Durin', 'foreman', ?, 'none-yet', ?, ?, ?, ?)`,
        [
          id,
          MINE,
          `session-${n}`,
          departed ? 'closed' : 'running',
          T0,
          T0,
          departed ? T0 + 1 : null,
          departed ? 'stopped' : null
        ]
      )
    })
    const ask = (id: string, dwarfId: string, kind: string, state: string) =>
      db.run(
        `INSERT INTO asks (id, dwarf_id, kind, channel, provider_request_id, payload_json, state,
           opened_at, closed_at)
         VALUES (?, ?, ?, 'driver', ?, '{}', ?, ?, ?)`,
        [
          id,
          dwarfId,
          kind,
          `request-${id}`,
          state,
          T0,
          ['open', 'answering'].includes(state) ? null : T0 + 2
        ]
      )
    ask(ASK.presentOpenQuestion, PRESENT, 'question', 'open')
    ask(ASK.presentAnsweringPermission, PRESENT, 'permission', 'answering')
    ask(ASK.otherClosedQuestion, OTHER, 'question', 'answered-in-app')
    ask(ASK.otherOpenPermission, OTHER, 'permission', 'open')
    ask(ASK.departedOpenQuestion, DEPARTED, 'question', 'open')
    const key = (
      key: string,
      dwarfId: string,
      kind: string,
      askId: string | null,
      suppressed: 0 | 1,
      withdrawnAt: number | null
    ) =>
      db.run(
        `INSERT INTO attention_keys (key, dwarf_id, kind, ask_id, host_epoch, emitted_at,
           suppressed, withdrawn_at)
         VALUES (?, ?, ?, ?, 'epoch-0118', ?, ?, ?)`,
        [key, dwarfId, kind, askId, T0, suppressed, withdrawnAt]
      )
    key(KEY.presentOpenQuestion, PRESENT, 'question', ASK.presentOpenQuestion, 0, null)
    key(
      KEY.presentAnsweringPermission,
      PRESENT,
      'permission',
      ASK.presentAnsweringPermission,
      1,
      null
    )
    key(KEY.presentWithdrawnTurn, PRESENT, 'turn-finished', null, 0, T0 + 3)
    key(KEY.otherSuppressedTurn, OTHER, 'turn-finished', null, 1, null)
    key(KEY.otherClosedQuestion, OTHER, 'question', ASK.otherClosedQuestion, 0, T0 + 3)
    key(KEY.departedOpenQuestion, DEPARTED, 'question', ASK.departedOpenQuestion, 0, null)
    const carry = (dwarfId: string, kind: string) =>
      db.run(
        `INSERT INTO attention_announced (dwarf_id, kind, pre_crash_key, host_epoch, recorded_at)
         VALUES (?, ?, ?, 'epoch-before-the-crash', ?)`,
        [dwarfId, kind, `${dwarfId}:${kind}:pre-crash`, T0]
      )
    carry(PRESENT, 'question')
    carry(PRESENT, 'permission')
    carry(OTHER, 'question')
    carry(OTHER, 'permission')
    carry(DEPARTED, 'question')
  })
  const step = new AttentionResetStep({ db, scope: runner })
  return { db, runner, step }
}

function keys(db: SqliteDatabase): string[] {
  return db.all('SELECT key FROM attention_keys ORDER BY key').map((row) => String(row['key']))
}

function carryOver(db: SqliteDatabase): string[] {
  return db
    .all('SELECT dwarf_id, kind FROM attention_announced ORDER BY dwarf_id, kind')
    .map((row) => `${String(row['dwarf_id'])}:${String(row['kind'])}`)
}

describe('AttentionResetStep', () => {
  it('[ADR-023] the attention step keeps only the keys of open asks of present dwarfs and deletes every other key, suppressed and turn keys included', () => {
    const { db, runner, step } = seeded()

    runner.inTransaction(() => step.reset(runner))

    expect(step.name).toBe('attention')
    expect(keys(db)).toStrictEqual([KEY.presentOpenQuestion, KEY.presentAnsweringPermission].sort())
  })

  it('[ADR-023] carry-over rows survive only for a present dwarf with an open ask of the same kind', () => {
    const { db, runner, step } = seeded()

    runner.inTransaction(() => step.reset(runner))

    // OTHER keeps its open permission ask's row; its question ask is closed, so that row goes.
    // DEPARTED's ask is still on file but its dwarf left, so its row goes too.
    expect(carryOver(db)).toStrictEqual([
      `${PRESENT}:permission`,
      `${PRESENT}:question`,
      `${OTHER}:permission`
    ])
  })

  it('[ADR-023] the step called with no open transaction throws and writes nothing', () => {
    const { db, runner, step } = seeded()
    const before = { keys: keys(db), carryOver: carryOver(db) }

    expect(() => step.reset(runner)).toThrow(HostInvariantError)

    expect({ keys: keys(db), carryOver: carryOver(db) }).toStrictEqual(before)
  })

  it('[ADR-023] the attention module imports nothing from host/modules/preferences', () => {
    const moduleRoot = join(import.meta.dirname, '..')
    const preferencesRoot = join(moduleRoot, '..', 'preferences')
    const files = readdirSync(moduleRoot, { withFileTypes: true, recursive: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .map((entry) => join(entry.parentPath, entry.name))
    expect(files.length).toBeGreaterThan(0)
    // Static imports and re-exports, bare imports and `import()`; relative ones resolved on disk.
    const specifiers =
      /\b(?:import|export)\s[^'"]*?\sfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
    const violations = files.flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(specifiers)]
        .map((match) => match[1] ?? match[2] ?? match[3] ?? '')
        .filter((spec) => spec.startsWith('.'))
        .filter((spec) => {
          const target = relative(preferencesRoot, resolve(dirname(file), spec))
          return target === '' || !(target.startsWith('..') || isAbsolute(target))
        })
        .map((spec) => `${relative(moduleRoot, file)} imports ${spec}`)
    )
    expect(violations).toStrictEqual([])
  })
})
