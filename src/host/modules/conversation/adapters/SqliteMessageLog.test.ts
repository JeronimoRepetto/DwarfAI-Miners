import { describe } from 'vitest'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import { SqliteTransactionRunner } from '../../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../../platform/sqlite/testing/templateDb'
import { runMessageLogContract } from '../testing/messageLog.contract'
import { seedConversationDb, sqliteProbe } from '../testing/sqliteConversationDb'
import { SqliteMessageLog } from './SqliteMessageLog'

// L3 (17 §1.3): the contract over a copy of the run's template database (schema v1, migration 1
// applied), with one mine and two dwarfs seeded, so every row meets the real CHECKs, the UNIQUE
// source key and the foreign keys of `messages` and `message_keys` (09 §4.4).
const T0 = 1_790_000_000_000

describe('SqliteMessageLog', () => {
  runMessageLogContract(() => {
    const { db } = openTemplateCopy()
    const runner = new SqliteTransactionRunner(db)
    const ids = new SequenceIdGenerator()
    const dwarfIds = seedConversationDb(db, runner, T0)
    const probe = sqliteProbe(db, runner, ids, T0)
    return {
      log: new SqliteMessageLog({ db, scope: runner, clock: new FakeClock(T0), ids }),
      dwarfIds,
      now: T0,
      inTransaction: (work) => runner.inTransaction(work),
      seedWaitingRow: probe.seedWaitingRow,
      seedSendingRow: probe.seedSendingRow,
      seedAnswersRecord: probe.seedAnswersRecord,
      keyOf: probe.keyOf,
      rowCount: probe.rowCount,
      rowIds: probe.rowIds,
      seedAsk: probe.seedAsk,
      dispose: () => undefined
    }
  })
})
