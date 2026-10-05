// layer: L5
// L5 (17 §1.5): the conversation module's `ResetDbStep` (16 §4.12) over a copy of the template
// database, the 09 §6.5 "Reset scope" probe for the conversation tables (09 §7.2): a live dwarf
// with provider messages, a `sending` person message, the `sending` "Answers:" record of an
// `answering` ask, the delivered record of an answered ask, an open activity run and an outcome
// line. Run with the other steps in the one `db` transaction, a later failure rolls its deletions
// back (ADR-023 item 4). L7 (17 §1.7): the module reaches the saga structurally, with no import of
// `preferences` (05 §1.3, R4).
//
// TC-107-01, TC-107-03, TC-107-04.
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import type { SqliteDatabase } from '../../../kernel/ports/sqliteDatabase'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import { SqliteTransactionRunner } from '../../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../../platform/sqlite/testing/templateDb'
import { createConversationResetStep } from '../index'
import { seedConversationDb } from '../testing/sqliteConversationDb'
import { SqliteActivityLog } from './SqliteActivityLog'
import { SqliteMessageLog } from './SqliteMessageLog'

const T0 = 1_790_000_000_000
const ASK = {
  answering: '00000000-0000-7000-8000-0000000107a1',
  answered: '00000000-0000-7000-8000-0000000107a2'
} as const
const MESSAGE = {
  sendingPerson: '00000000-0000-7000-8000-0000000107b1',
  sendingRecord: '00000000-0000-7000-8000-0000000107b2',
  deliveredRecord: '00000000-0000-7000-8000-0000000107b3'
} as const

/** The probe: the template copy with a live dwarf's conversation rows of each kind. */
function seeded() {
  const { db } = openTemplateCopy()
  const runner = new SqliteTransactionRunner(db)
  const [dwarf] = seedConversationDb(db, runner, T0)
  const log = new SqliteMessageLog({
    db,
    scope: runner,
    clock: new FakeClock(T0),
    ids: new SequenceIdGenerator()
  })
  const activity = new SqliteActivityLog({ db, scope: runner })
  runner.inTransaction(() => {
    log.append(
      dwarf,
      [
        {
          sourceKey: 'claude:claude:session-0:event-1',
          role: 'person',
          text: 'hi',
          providerTime: T0
        },
        {
          sourceKey: 'claude:claude:session-0:event-2',
          role: 'dwarf',
          text: 'hello',
          providerTime: T0
        }
      ],
      'transcript'
    )
    const ask = (id: string, state: 'answering' | 'answered-in-app') =>
      db.run(
        `INSERT INTO asks (id, dwarf_id, kind, channel, provider_request_id, payload_json, state,
           opened_at, closed_at)
         VALUES (?, ?, 'permission', 'driver', ?, '{}', ?, ?, ?)`,
        [id, dwarf, `request-${id}`, state, T0, state === 'answering' ? null : T0 + 1]
      )
    ask(ASK.answering, 'answering')
    ask(ASK.answered, 'answered-in-app')
    const message = (id: string, role: 'person' | 'answers-record', askId: string | null) =>
      db.run(
        `INSERT INTO messages (id, dwarf_id, role, text, origin, created_at, ask_id)
         VALUES (?, ?, ?, ?, 'dwarfai', ?, ?)`,
        [id, dwarf, role, `${role} text`, T0, askId]
      )
    const delivery = (id: string, kind: 'message' | 'answers-record', phase: string) =>
      db.run(
        `INSERT INTO deliveries (message_id, dwarf_id, kind, phase, sent_at, phase_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, dwarf, kind, phase, T0, T0]
      )
    message(MESSAGE.sendingPerson, 'person', null)
    delivery(MESSAGE.sendingPerson, 'message', 'sending')
    message(MESSAGE.sendingRecord, 'answers-record', ASK.answering)
    delivery(MESSAGE.sendingRecord, 'answers-record', 'sending')
    message(MESSAGE.deliveredRecord, 'answers-record', ASK.answered)
    delivery(MESSAGE.deliveredRecord, 'answers-record', 'delivered')
    db.run(
      `INSERT INTO ask_answers (request_id, ask_id, outcome, message_id, at, settled_at)
       VALUES ('answer-1', ?, 'accepted', ?, ?, ?)`,
      [ASK.answered, MESSAGE.deliveredRecord, T0, T0 + 1]
    )
    activity.saveDisclosure({
      id: '00000000-0000-7000-8000-0000000107c1',
      dwarfId: dwarf,
      turnKey: 'claude:claude:session-0:turn-1',
      open: true,
      stepCount: 1,
      summaries: ['Ran the tests'],
      openedAt: T0
    })
    activity.saveOutcome({
      dwarfId: dwarf,
      kind: 'working',
      stepCount: 1,
      parts: [{ kind: 'steps-so-far', n: 1 }],
      reliability: 'reliable',
      at: T0
    })
  })
  const step = createConversationResetStep({ db, scope: runner })
  return { db, runner, step }
}

/** Every conversation row, read back from the tables; rows spread off their null prototype. */
function tables(db: SqliteDatabase) {
  const rows = (sql: string) => db.all(sql).map((row) => ({ ...row }))
  return {
    messages: rows('SELECT id, role, ask_id FROM messages ORDER BY id'),
    deliveries: rows('SELECT message_id, phase FROM deliveries ORDER BY message_id'),
    keys: rows('SELECT source_key, message_id FROM message_keys ORDER BY source_key'),
    answers: rows('SELECT request_id, message_id FROM ask_answers ORDER BY request_id'),
    runs: rows('SELECT id FROM activity_disclosures ORDER BY id'),
    outcomes: rows('SELECT dwarf_id FROM outcome_lines ORDER BY dwarf_id')
  }
}

describe('ConversationResetStep on schema v1', () => {
  it('[ADR-023] committed in the db transaction, only the sending rows and their deliveries stay, every message key stays and the activity and outcome tables are empty', () => {
    const { db, runner, step } = seeded()

    runner.inTransaction(() => step.reset(runner))

    expect(tables(db)).toStrictEqual({
      messages: [
        { id: MESSAGE.sendingPerson, role: 'person', ask_id: null },
        { id: MESSAGE.sendingRecord, role: 'answers-record', ask_id: ASK.answering }
      ],
      deliveries: [
        { message_id: MESSAGE.sendingPerson, phase: 'sending' },
        { message_id: MESSAGE.sendingRecord, phase: 'sending' }
      ],
      keys: [
        { source_key: 'claude:claude:session-0:event-1', message_id: null },
        { source_key: 'claude:claude:session-0:event-2', message_id: null }
      ],
      answers: [{ request_id: 'answer-1', message_id: null }],
      runs: [],
      outcomes: []
    })
  })

  it('[ADR-023] run with the other steps in one transaction, a failure in a later step rolls the conversation deletions back too', () => {
    const { db, runner, step } = seeded()
    const before = tables(db)
    const later = {
      name: 'later',
      reset(tx: TransactionRunner): void {
        tx.inTransaction(() => {
          throw new Error('a later ResetDbStep failed')
        })
      }
    }

    expect(() =>
      runner.inTransaction(() => {
        step.reset(runner)
        later.reset(runner)
      })
    ).toThrow('a later ResetDbStep failed')

    expect(before.messages).toHaveLength(5)
    expect(tables(db)).toStrictEqual(before)
  })

  it('[ADR-023] the conversation module imports nothing from host/modules/preferences', () => {
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
