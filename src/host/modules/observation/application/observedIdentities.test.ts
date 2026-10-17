// layer: L2
// L2 (17 §1.2): the module's read of the provider identity of a dwarf it observed this Host run
// (`ObservedIdentities`; package gap, kept off the frozen `ObservationQueries` like
// `ObservedProcessIdentities`): the observed-session send path's route read (ISSUE-167, INV-33),
// answered without asking crew (whose `hasDeliveryRoute` it serves).
import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingEventBus } from '../../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import type { DwarfId, FolderPath, ProviderIdentity } from '../../../kernel/domain/values'
import type { FileSystem } from '../../../kernel/ports/fileSystem'
import { createObservation, type ObservationEvent } from '../index'
import { FakeObservationAdapter } from '../ports/fakes/FakeObservationAdapter'
import { InMemoryCursorStore } from '../ports/fakes/InMemoryCursorStore'
import { InMemoryEndedAgentLedger } from '../ports/fakes/InMemoryEndedAgentLedger'
import { InMemoryObservedSessionStore } from '../ports/fakes/InMemoryObservedSessionStore'
import { RecordingObservedBatchSink } from '../ports/fakes/RecordingObservedBatchSink'
import { InMemoryBoundDwarfs } from '../testing/inMemoryBoundDwarfs'
import { InMemoryTransactions } from '../testing/inMemoryTransactions'

const T0 = 1_790_000_000_000
const MINE = '/work/moria' as FolderPath
const S1: ProviderIdentity = { providerId: 'simulated', providerSessionId: 'session-1' }
const UNKNOWN = '00000000-0000-7000-8000-00000000dead' as DwarfId

describe('ObservedIdentities', () => {
  it('[INV-33, ADR-015] answers the provider identity of a dwarf observation wrote to, and null for any other', async () => {
    const transactions = new InMemoryTransactions()
    const dwarfs = new InMemoryBoundDwarfs()
    const cursors = new InMemoryCursorStore(transactions)
    const sessions = new InMemoryObservedSessionStore(transactions, dwarfs)
    const ended = new InMemoryEndedAgentLedger(transactions)
    const sink = new RecordingObservedBatchSink(transactions)
    for (const participant of [cursors, sessions, ended, sink]) transactions.enlist(participant)
    const clock = new FakeClock(T0)
    const adapter = new FakeObservationAdapter('simulated')
    const observation = createObservation({
      adapters: [adapter],
      fs: {} as FileSystem,
      cursors,
      sessions,
      sink,
      transactions,
      bus: new RecordingEventBus<ObservationEvent>({ transactionScope: transactions }),
      clock,
      scheduler: new FakeScheduler(clock),
      ids: new SequenceIdGenerator(),
      hostEpoch: 'epoch-0167',
      log: new RecordingDiagnosticsLog(),
      ended
    })
    const dwarfId = dwarfs.bind(S1, MINE, T0)
    expect(observation.identities.identityOf(dwarfId)).toBeNull()

    adapter.sources = [
      {
        streamId: 's1',
        adapterId: 'simulated',
        path: '/provider/s1.jsonl',
        fileIdentity: 'file-1',
        size: 100
      }
    ]
    adapter.onRead('s1', () => ({
      events: [
        { kind: 'session', sourceEventId: 'e1', identity: S1, cwd: MINE, at: T0 },
        {
          kind: 'entries',
          sourceEventId: 'e2',
          identity: S1,
          entries: [{ sourceKey: 'simulated:s1:e2', role: 'person', text: 'dig', providerTime: T0 }]
        }
      ],
      next: { adapterId: 'simulated', kind: 'byte-offset', value: 100, fileIdentity: 'file-1' },
      warnings: []
    }))
    observation.control.start()
    await observation.whenIdle()
    observation.control.stop()

    expect(observation.identities.identityOf(dwarfId)).toEqual(S1)
    expect(observation.identities.identityOf(UNKNOWN)).toBeNull()
  })
})
