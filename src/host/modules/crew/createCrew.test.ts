// layer: L3
// L3 (17 §1.3): `createCrew` composes the module over a copy of the run's template database
// (schema v1) with the kernel `SqliteLifecycleFactLog`: an arrival lands in `dwarfs` and in
// `dwarf_lifecycle_facts` in one transaction, and the queries read it back (16 §4.2; 09 §4.2).
import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { RecordingEventBus } from '../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import type { MineId } from '../../kernel/domain/values'
import { SqliteLifecycleFactLog } from '../../platform/sqlite/SqliteLifecycleFactLog'
import { SqliteTransactionRunner } from '../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../platform/sqlite/testing/templateDb'
import { createCrew, type CrewEvent } from './index'

const T0 = 1_790_000_000_000
const MINE = '00000000-0000-7000-8000-0000000000f1' as MineId

describe('createCrew', () => {
  it('[INV-21, ADR-006] an arrival twice over the Host database stores one dwarf and one DwarfArrived fact', () => {
    const { db } = openTemplateCopy()
    const transactions = new SqliteTransactionRunner(db)
    const clock = new FakeClock(T0)
    const ids = new SequenceIdGenerator()
    transactions.inTransaction(() =>
      db.run(
        `INSERT INTO mines (id, canonical_path, name, name_norm, state, created_at, last_used_at)
         VALUES (?, '/work/mine', 'mine', 'mine', 'active', ?, ?)`,
        [MINE, T0, T0]
      )
    )
    const bus = new RecordingEventBus<CrewEvent>({ transactionScope: transactions })
    const crew = createCrew({
      db,
      transactions,
      lifecycleFacts: new SqliteLifecycleFactLog({ db, scope: transactions, ids, clock }),
      bus,
      clock,
      scheduler: new FakeScheduler(clock),
      ids,
      hostEpoch: 'epoch-0069',
      links: { owned: () => false, hasDeliveryRoute: () => false }
    })
    const identity = { providerId: 'codex', providerSessionId: 'thread-1' }

    const first = crew.commands.arrive({ mineId: MINE, identity, rank: 'foreman', status: 'idle' })
    const again = crew.commands.arrive({ mineId: MINE, identity, rank: 'foreman', status: 'idle' })

    expect(again).toBe(first)
    expect(crew.queries.crewOf(MINE).map((d) => [d.id, d.displayName, d.status])).toEqual([
      [first, 'codex-thread-1', 'idle']
    ])
    expect(db.all('SELECT type FROM dwarf_lifecycle_facts')).toEqual([{ type: 'DwarfArrived' }])
    expect(bus.ofType('DwarfArrived')).toHaveLength(1)
  })
})
