import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import { SqliteTransactionRunner } from '../../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../../platform/sqlite/testing/templateDb'
import { seedConversationDb, sqliteProbe } from '../testing/sqliteConversationDb'
import { SqliteMessageLog } from './SqliteMessageLog'

// L5 (17 §1.5) on the template database: the echo merge of 09 §5.2 step 2a read back from the
// rows themselves, not through the port.
const T0 = 1_790_000_000_000

describe('SqliteMessageLog on schema v1', () => {
  it('[ADR-007] a merged echo sets source_key, clears pending_echo and points message_keys.message_id at the merged row', () => {
    const { db } = openTemplateCopy()
    const runner = new SqliteTransactionRunner(db)
    const ids = new SequenceIdGenerator()
    const [dwarf] = seedConversationDb(db, runner, T0)
    const waiting = sqliteProbe(db, runner, ids, T0).seedWaitingRow(dwarf, 'send-request-7', 'hi')
    const log = new SqliteMessageLog({ db, scope: runner, clock: new FakeClock(T0 + 10), ids })
    const sourceKey = 'claude:claude:session-0:event-1'

    const result = runner.inTransaction(() =>
      log.append(
        dwarf,
        [{ sourceKey, role: 'person', text: 'hi', providerTime: T0 + 5, echoOf: 'send-request-7' }],
        'live-stream'
      )
    )

    expect(result).toEqual({ inserted: 0, appended: [] })
    expect(
      db.all(
        'SELECT id, source_key, pending_echo, provider_time, origin FROM messages WHERE dwarf_id = ?',
        [dwarf]
      )
    ).toEqual([
      {
        id: waiting,
        source_key: sourceKey,
        pending_echo: null,
        provider_time: T0 + 5,
        origin: 'dwarfai'
      }
    ])
    expect(
      db.all('SELECT source_key, dwarf_id, message_id, first_seen_at FROM message_keys')
    ).toEqual([
      { source_key: sourceKey, dwarf_id: dwarf, message_id: waiting, first_seen_at: T0 + 10 }
    ])
  })
})
