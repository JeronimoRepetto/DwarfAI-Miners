import { describe } from 'vitest'
import type { DwarfId, LaunchId } from '../../../../kernel/domain/values'
import { FakeClock } from '../../../../kernel/fakes/FakeClock'
import { SequenceIdGenerator } from '../../../../kernel/fakes/SequenceIdGenerator'
import type { SqliteDatabase } from '../../../../kernel/ports/sqliteDatabase'
import { SqliteTransactionRunner } from '../../../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../../../platform/sqlite/testing/templateDb'
import { runLaunchRecordStoreContract } from '../../testing/launchRecordStore.contract'
import { runLaunchStoreContract } from '../../testing/launchStore.contract'
import { runProcessRecordStoreContract } from '../../testing/processRecordStore.contract'
import {
  MINE,
  MINE_FOLDER,
  T0,
  seedDelegation,
  seedDwarf,
  seedMine,
  seedSucceededLaunch
} from '../../testing/sqliteLaunchingDb'
import { SqliteLaunchRecordStore } from './SqliteLaunchRecordStore'
import { SqliteLaunchStore } from './SqliteLaunchStore'
import { SqliteProcessRecordStore } from './SqliteProcessRecordStore'

// L3 (17 §1.3): each launching store contract over a copy of the run's template database (schema
// v1, migration 1 applied), so every row meets the real CHECKs, UNIQUE keys and foreign keys of
// `launches`, `processes` and `launch_records` (09 §4.3).
const PARENT = '00000000-0000-7000-8000-0000000161d0' as DwarfId
const DWARF = '00000000-0000-7000-8000-0000000161d1' as DwarfId
const DELEGATION = '00000000-0000-7000-8000-0000000161de'

function instant(db: SqliteDatabase, column: 'settled_at' | 'seen_at', id: LaunchId) {
  const [row] = db.all(`SELECT ${column} AS at FROM launches WHERE id = ?`, [id])
  return row === undefined || row['at'] === null ? null : Number(row['at'])
}

describe('SqliteLaunchStore', () => {
  runLaunchStoreContract(() => {
    const { db } = openTemplateCopy()
    const runner = new SqliteTransactionRunner(db)
    seedMine(db, runner)
    seedDwarf(db, runner, PARENT)
    seedDwarf(db, runner, DWARF)
    seedDelegation(db, runner, DELEGATION, PARENT)
    const clock = new FakeClock(T0)
    return {
      store: new SqliteLaunchStore({
        db,
        scope: runner,
        clock,
        folderOf: (mineId) => (mineId === MINE ? MINE_FOLDER : null)
      }),
      clock,
      mineId: MINE,
      delegation: { delegationId: DELEGATION, parentDwarfId: PARENT },
      dwarfId: DWARF,
      settledAt: (id) => instant(db, 'settled_at', id),
      seenAt: (id) => instant(db, 'seen_at', id),
      inTransaction: (work) => runner.inTransaction(work),
      dispose: () => undefined
    }
  })
})

describe('SqliteLaunchRecordStore', () => {
  runLaunchRecordStoreContract(() => {
    const { db } = openTemplateCopy()
    const runner = new SqliteTransactionRunner(db)
    seedMine(db, runner)
    const clock = new FakeClock(T0)
    const dwarfs = new Set<DwarfId>()
    return {
      store: new SqliteLaunchRecordStore({ db, scope: runner }),
      processes: new SqliteProcessRecordStore({
        db,
        scope: runner,
        clock,
        ids: new SequenceIdGenerator()
      }),
      owned: (dwarfId, launchId, letJevChoose) => {
        if (!dwarfs.has(dwarfId)) seedDwarf(db, runner, dwarfId)
        dwarfs.add(dwarfId)
        seedSucceededLaunch(db, runner, launchId, letJevChoose)
      },
      inTransaction: (work) => runner.inTransaction(work),
      dispose: () => undefined
    }
  })
})

describe('SqliteProcessRecordStore', () => {
  runProcessRecordStoreContract(() => {
    const { db } = openTemplateCopy()
    const runner = new SqliteTransactionRunner(db)
    seedMine(db, runner)
    seedDwarf(db, runner, DWARF)
    const launchId = '00000000-0000-7000-8000-0000000161a1' as LaunchId
    seedSucceededLaunch(db, runner, launchId, false)
    const clock = new FakeClock(T0)
    return {
      store: new SqliteProcessRecordStore({
        db,
        scope: runner,
        clock,
        ids: new SequenceIdGenerator()
      }),
      clock,
      launchId,
      inTransaction: (work) => runner.inTransaction(work),
      dispose: () => undefined
    }
  })
})
