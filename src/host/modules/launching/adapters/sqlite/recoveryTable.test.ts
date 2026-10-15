import { describe, expect, it } from 'vitest'
import type { ProcessIdentity } from '../../../../kernel/domain/processIdentity'
import type { HostEpoch, LaunchId } from '../../../../kernel/domain/values'
import { FakeClock } from '../../../../kernel/fakes/FakeClock'
import { SequenceIdGenerator } from '../../../../kernel/fakes/SequenceIdGenerator'
import type { SqliteDatabase } from '../../../../kernel/ports/sqliteDatabase'
import { NodeSqliteDatabase } from '../../../../platform/sqlite/NodeSqliteDatabase'
import { SqliteTransactionRunner } from '../../../../platform/sqlite/SqliteTransactionRunner'
import { copyTemplateDb } from '../../../../platform/sqlite/testing/templateDb'
import { requestLaunch } from '../../domain/launch'
import { launchRecording, type LaunchingStores } from '../../testing/launchRecording'
import { MINE, MINE_FOLDER, T0, seedMine } from '../../testing/sqliteLaunchingDb'
import { SqliteLaunchRecordStore } from './SqliteLaunchRecordStore'
import { SqliteLaunchStore } from './SqliteLaunchStore'
import { SqliteProcessRecordStore } from './SqliteProcessRecordStore'

// The recovery table's seed (16 §4.5; ADR-015 Verification; 07 S4.01), over a real database file:
// the Host writes a launch's rows in the order of `testing/launchRecording.ts`, stops between the
// spawn and the handshake (its connection goes away with nothing more written), and the next Host
// opens the same file. ISSUE-173's recovery pass starts from what this leaves.
const EPOCH: HostEpoch = 'epoch-before-the-crash'
const ROOT: ProcessIdentity = { pid: 7310, processStartTimeMs: T0 - 1_200, bootId: 'boot-0161' }

function storesOn(db: SqliteDatabase, clock: FakeClock): LaunchingStores {
  const runner = new SqliteTransactionRunner(db)
  return {
    launches: new SqliteLaunchStore({
      db,
      scope: runner,
      clock,
      folderOf: (mineId) => (mineId === MINE ? MINE_FOLDER : null)
    }),
    processes: new SqliteProcessRecordStore({
      db,
      scope: runner,
      clock,
      ids: new SequenceIdGenerator()
    }),
    records: new SqliteLaunchRecordStore({ db, scope: runner }),
    inTransaction: (work) => runner.inTransaction(work)
  }
}

describe('launch recording across a Host crash (SQLite)', () => {
  it('[ADR-015, CH-11] after a crash between the spawn and the handshake a processes row exists for the live owned session', () => {
    const path = copyTemplateDb()
    const clock = new FakeClock(T0)
    const before = NodeSqliteDatabase.open(path)
    let launchId: LaunchId
    try {
      seedMine(before, new SqliteTransactionRunner(before))
      const recording = launchRecording(storesOn(before, clock))
      const sent = requestLaunch({
        id: '00000000-0000-7000-8161-00000000c411' as LaunchId,
        request: {
          mineId: MINE,
          way: { kind: 'supplier', providerId: 'claude' },
          prompt: 'Dig the north shaft',
          jevOn: false,
          jevAutoAccept: false
        },
        hostEpoch: EPOCH
      })
      if (!sent.ok) throw new Error('fixture request refused')
      launchId = sent.value.launch.id
      recording.spawned(recording.requested(sent.value.launch), ROOT, clock.now())
      // The Host stops here: the handshake never answers, nothing more is written.
    } finally {
      before.close()
    }

    const after = NodeSqliteDatabase.open(path)
    try {
      const stores = storesOn(after, new FakeClock(T0 + 60_000))
      expect(stores.processes.live()).toEqual([
        { identity: ROOT, purpose: 'session', launchId, hostEpoch: EPOCH }
      ])
      expect(stores.launches.inFlight().map((l) => [l.id, l.state, l.spawnedAt])).toEqual([
        [launchId, 'spawned', T0]
      ])
      expect(stores.records.live()).toEqual([])
    } finally {
      after.close()
    }
  })
})
