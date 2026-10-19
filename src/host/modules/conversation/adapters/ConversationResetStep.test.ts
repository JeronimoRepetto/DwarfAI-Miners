import { describe } from 'vitest'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import { SqliteTransactionRunner } from '../../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../../platform/sqlite/testing/templateDb'
import { runConversationResetStepContract } from '../testing/resetStep.contract'
import { seedConversationDb, sqliteProbe, storedRuns } from '../testing/sqliteConversationDb'
import { ConversationResetStep } from './sqlite/ConversationResetStep'
import { SqliteActivityLog } from './SqliteActivityLog'
import { SqliteMessageLog } from './SqliteMessageLog'

// L3 (17 §1.3): the conversation module's `ResetDbStep` (16 §4.12) over a copy of the run's
// template database (schema v1, migration 1 applied), with one mine and two live dwarfs seeded, so
// the deletions meet the real foreign keys: `deliveries` cascading with their message and
// `message_keys.message_id` set to NULL (09 §4.4, §7.2). The probe rows are written through the
// SQLite adapters.
//
// TC-107-01, TC-107-02.
const T0 = 1_790_000_000_000

describe('ConversationResetStep', () => {
  runConversationResetStepContract(() => {
    const { db } = openTemplateCopy()
    const runner = new SqliteTransactionRunner(db)
    const ids = new SequenceIdGenerator()
    const dwarfIds = seedConversationDb(db, runner, T0)
    const probe = sqliteProbe(db, runner, ids, T0)
    return {
      step: new ConversationResetStep({ db, scope: runner }),
      transactions: runner,
      log: new SqliteMessageLog({ db, scope: runner, clock: new FakeClock(T0), ids }),
      activity: new SqliteActivityLog({ db, scope: runner }),
      dwarfIds,
      seedSendingRow: probe.seedSendingRow,
      seedAnswersRecord: probe.seedAnswersRecord,
      keyOf: probe.keyOf,
      runs: (dwarfId) => storedRuns(db, dwarfId),
      dispose: () => undefined
    }
  })
})
