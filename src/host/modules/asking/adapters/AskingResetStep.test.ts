// layer: L5
// L5 (17 §1.5): the asking module's `ResetDbStep` (16 §4.12) over a copy of the template database,
// the 09 §6.5 "Reset scope" probe for the asking tables (09 §7.2 row "`asks` open or answering,
// their `ask_answers`": kept; closed asks deleted, their `ask_answers` and `attention_keys`
// cascade). L7 (17 §1.7): the module reaches the saga structurally, with no import of
// `preferences` (05 §1.3, R4).
//
// TC-139-01.
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HostInvariantError } from '../../../kernel/domain/errors'
import type { AskId } from '../../../kernel/domain/values'
import type { SqliteDatabase } from '../../../kernel/ports/sqliteDatabase'
import type { Ask, AskState } from '../domain/ask'
import { permissionAsk, questionAsk } from '../testing/askRepository.contract'
import { answerRows, ASK_T0, seededAskDb } from '../testing/sqliteAskDb'
import { AskingResetStep } from './sqlite/AskingResetStep'

const TERMINAL: readonly AskState[] = [
  'answered-in-app',
  'answered-elsewhere',
  'cancelled',
  'closed-by-death',
  'auto-denied'
]

/**
 * The seeded probe: an open ask, an `answering` ask with its pending `ask_answers` row (each on its
 * own dwarf: one answering ask per dwarf, `asks_one_answering`), and one closed ask of each
 * terminal state with an answer attempt and an attention key.
 */
function seeded() {
  const { db, runner, open, dwarfs } = seededAskDb()
  const [first, second] = dwarfs
  const repository = open()
  const openAsk = questionAsk(1, first, { currentStep: 1 })
  const answering = permissionAsk(2, second)
  const closed: Ask[] = TERMINAL.map((state, n) =>
    permissionAsk(10 + n, first, { state, closedAt: ASK_T0 + 100 })
  )
  runner.inTransaction(() => {
    ;[openAsk, answering, ...closed].forEach((ask) => repository.save(ask))
    repository.settle(answering.id as AskId, { requestId: 'request-answering' })
    closed.forEach((ask, n) => {
      db.run(
        `INSERT INTO ask_answers (request_id, ask_id, outcome, at, settled_at)
         VALUES (?, ?, 'accepted', ?, ?)`,
        [`attempt-${n}`, ask.id, ASK_T0 + 50, ASK_T0 + 60]
      )
      db.run(
        `INSERT INTO attention_keys (key, dwarf_id, kind, ask_id, host_epoch, emitted_at)
         VALUES (?, ?, 'permission', ?, 'epoch-0139', ?)`,
        [`${first}:permission:${ask.id}`, first, ask.id, ASK_T0]
      )
    })
    db.run(
      `INSERT INTO attention_keys (key, dwarf_id, kind, ask_id, host_epoch, emitted_at)
       VALUES (?, ?, 'question', ?, 'epoch-0139', ?)`,
      [`${first}:question:${openAsk.id}`, first, openAsk.id, ASK_T0]
    )
  })
  const step = new AskingResetStep({ db, scope: runner })
  return { db, runner, step, openAsk, answering, closed }
}

function askIds(db: SqliteDatabase): string[] {
  return db.all('SELECT id FROM asks ORDER BY id').map((row) => String(row['id']))
}

function count(db: SqliteDatabase, table: 'asks' | 'ask_answers' | 'attention_keys'): number {
  return Number(db.all(`SELECT COUNT(*) AS n FROM ${table}`)[0]?.['n'])
}

describe('AskingResetStep', () => {
  it('[ADR-023] the asking step deletes every closed ask with its answer attempts and keeps open and answering asks', () => {
    const { db, runner, step, openAsk, answering } = seeded()

    runner.inTransaction(() => step.reset(runner))

    expect(step.name).toBe('asking')
    expect(askIds(db)).toStrictEqual([openAsk.id, answering.id].sort())
    // The answering ask keeps its pending answer attempt; the closed asks' attempts went.
    expect(answerRows(db).map((row) => row['request_id'])).toStrictEqual(['request-answering'])
    // The open ask is untouched: still on its step.
    expect(
      db
        .all('SELECT current_step, state FROM asks WHERE id = ?', [openAsk.id])
        .map((row) => ({ ...row }))
    ).toStrictEqual([{ current_step: 1, state: 'open' }])
  })

  it('[ADR-023] the attention keys of deleted asks go with them by cascade', () => {
    const { db, runner, step, openAsk } = seeded()
    expect(count(db, 'attention_keys')).toBe(TERMINAL.length + 1)

    runner.inTransaction(() => step.reset(runner))

    expect(db.all('SELECT ask_id FROM attention_keys').map((row) => ({ ...row }))).toStrictEqual([
      { ask_id: openAsk.id }
    ])
  })

  it('[ADR-023] the step with no open transaction throws and writes nothing', () => {
    const { db, runner, step } = seeded()
    const before = {
      asks: count(db, 'asks'),
      answers: count(db, 'ask_answers'),
      keys: count(db, 'attention_keys')
    }

    expect(() => step.reset(runner)).toThrow(HostInvariantError)

    expect({
      asks: count(db, 'asks'),
      answers: count(db, 'ask_answers'),
      keys: count(db, 'attention_keys')
    }).toStrictEqual(before)
  })

  it('[ADR-023] the asking module imports nothing from host/modules/preferences', () => {
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
