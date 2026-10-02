import { describe, expect, it } from 'vitest'
import { HostInvariantError } from '../../../kernel/domain/errors'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import type { DwarfId } from '../../../kernel/domain/values'
import type { SqliteDatabase } from '../../../kernel/ports/sqliteDatabase'
import { SqliteTransactionRunner } from '../../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../../platform/sqlite/testing/templateDb'
import { runAttentionLedgerContract } from '../testing/attentionLedger.contract'
import { SqliteAttentionLedger } from './SqliteAttentionLedger'

const T0 = 1_790_000_000_000
const EPOCH = 'epoch-0110'
const MINE = '00000000-0000-7000-8000-0000000110f1'
const DWARFS = [
  '00000000-0000-7000-8000-0000000110d1' as DwarfId,
  '00000000-0000-7000-8000-0000000110d2' as DwarfId
] as const

/** A template copy with one mine and two dwarfs, the rows `attention_keys` references. */
function seeded() {
  const { db } = openTemplateCopy()
  const runner = new SqliteTransactionRunner(db)
  runner.inTransaction(() => {
    db.run(
      `INSERT INTO mines (id, canonical_path, name, name_norm, state, created_at, last_used_at)
       VALUES (?, '/work/mine-one', 'mine-one', 'mine-one', 'active', ?, ?)`,
      [MINE, T0, T0]
    )
    DWARFS.forEach((id, n) => {
      db.run(
        `INSERT INTO dwarfs (id, mine_id, provider_id, provider_session_id, base_name, rank,
           process_state, turn_state, arrived_at, last_activity_at)
         VALUES (?, ?, 'claude', ?, 'Durin', 'foreman', 'running', 'none-yet', ?, ?)`,
        [id, MINE, `session-${n}`, T0, T0]
      )
    })
  })
  const clock = new FakeClock(T0)
  const open = (): SqliteAttentionLedger =>
    new SqliteAttentionLedger({ db, scope: runner, clock, hostEpoch: EPOCH })
  return { db, runner, clock, open }
}

function keyRows(db: SqliteDatabase) {
  return db
    .all(
      `SELECT key, dwarf_id, kind, ask_id, host_epoch, emitted_at, suppressed, withdrawn_at
       FROM attention_keys ORDER BY key`
    )
    .map((row) => ({ ...row }))
}

// L3 (17 §1.3): the contract over a copy of the run's template database (schema v1), so every row
// meets the real CHECKs and foreign keys of `attention_keys` and `attention_announced` (09 §4.5).
describe('SqliteAttentionLedger', () => {
  runAttentionLedgerContract(() => {
    const { db, runner, clock, open } = seeded()
    let asks = 0
    return {
      ledger: open(),
      dwarfs: DWARFS,
      inTransaction: (work) => runner.inTransaction(work),
      openAsk: (dwarfId, kind) => {
        const id = `00000000-0000-7000-8000-${String(++asks).padStart(12, '0')}`
        runner.inTransaction(() =>
          db.run(
            `INSERT INTO asks (id, dwarf_id, kind, channel, provider_request_id, payload_json,
               state, opened_at)
             VALUES (?, ?, ?, 'driver', ?, '{}', 'open', ?)`,
            [id, dwarfId, kind, `request-${asks}`, clock.now()]
          )
        )
        return id
      },
      recordCarryOver: (dwarfId, kind, preCrashKey) =>
        runner.inTransaction(() =>
          db.run(
            `INSERT INTO attention_announced (dwarf_id, kind, pre_crash_key, host_epoch, recorded_at)
             VALUES (?, ?, ?, 'epoch-before-the-crash', ?)`,
            [dwarfId, kind, preCrashKey, clock.now()]
          )
        ),
      reopen: open,
      clock,
      dispose: () => undefined
    }
  })

  it('[ADR-018, INV-100] a claimed key stores its dwarf, kind, ask, epoch and decision instant, and a suppressed key is flagged', () => {
    const { db, runner, open } = seeded()
    const [dwarf] = DWARFS
    const askId = '00000000-0000-7000-8000-0000000a5c01'
    runner.inTransaction(() =>
      db.run(
        `INSERT INTO asks (id, dwarf_id, kind, channel, provider_request_id, payload_json, state,
           opened_at)
         VALUES (?, ?, 'question', 'driver', 'request-1', '{}', 'open', ?)`,
        [askId, dwarf, T0]
      )
    )
    const ledger = open()

    runner.inTransaction(() => {
      ledger.markEmitted(`${dwarf}:question:${askId}`, dwarf, 'question')
      ledger.markSuppressed(`${dwarf}:turn-finished:turn-9`, dwarf, 'turn-finished')
    })

    expect(keyRows(db)).toStrictEqual([
      {
        key: `${dwarf}:question:${askId}`,
        dwarf_id: dwarf,
        kind: 'question',
        ask_id: askId,
        host_epoch: EPOCH,
        emitted_at: T0,
        suppressed: 0,
        withdrawn_at: null
      },
      {
        key: `${dwarf}:turn-finished:turn-9`,
        dwarf_id: dwarf,
        kind: 'turn-finished',
        ask_id: null,
        host_epoch: EPOCH,
        emitted_at: T0,
        suppressed: 1,
        withdrawn_at: null
      }
    ])
  })

  it('[ADR-018] a write outside the caller transaction is refused and stores nothing (16 §2.2)', () => {
    const { db, runner, open } = seeded()
    const [dwarf] = DWARFS
    const ledger = open()

    expect(() =>
      ledger.markEmitted(`${dwarf}:turn-finished:turn-1`, dwarf, 'turn-finished')
    ).toThrow(HostInvariantError)
    expect(() => ledger.consumeCarryOver(`${dwarf}:question`)).toThrow(HostInvariantError)
    expect(keyRows(db)).toStrictEqual([])
    expect(runner.isInTransaction()).toBe(false)
  })

  it('[ADR-018] an ask key that does not name its dwarf and kind is refused (`dwarfId:kind:askId`)', () => {
    const { db, runner, open } = seeded()
    const [dwarf, other] = DWARFS
    const ledger = open()

    expect(() =>
      runner.inTransaction(() => ledger.markEmitted(`${other}:question:ask-1`, dwarf, 'question'))
    ).toThrow(HostInvariantError)
    expect(keyRows(db)).toStrictEqual([])
  })
})
