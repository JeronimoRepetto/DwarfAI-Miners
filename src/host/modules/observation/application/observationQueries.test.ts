// layer: L2
// L2 (17 §1.2): `ObservationQueries` (16 §4.3) over the in-memory observed-session index.
import { describe, expect, it } from 'vitest'
import type { FolderPath, ProviderIdentity } from '../../../kernel/domain/values'
import { InMemoryObservedSessionStore } from '../ports/fakes/InMemoryObservedSessionStore'
import { InMemoryBoundDwarfs } from '../testing/inMemoryBoundDwarfs'
import { InMemoryTransactions } from '../testing/inMemoryTransactions'
import { createObservationQueries } from './observationQueries'

const T0 = 1_790_000_000_000
const MINE = '/work/moria' as FolderPath
const OBSERVED: ProviderIdentity = { providerId: 'simulated', providerSessionId: 'observed-1' }
const LAUNCHED: ProviderIdentity = { providerId: 'simulated', providerSessionId: 'launched-1' }

describe('ObservationQueries', () => {
  it('[ADR-015] ObservationQueries.observedSessionOf answers the stored ref of an observed dwarf and null for a launched one', () => {
    const transactions = new InMemoryTransactions()
    const dwarfs = new InMemoryBoundDwarfs()
    const sessions = new InMemoryObservedSessionStore(transactions, dwarfs)
    transactions.enlist(sessions)
    const observed = dwarfs.bind(OBSERVED, MINE, T0)
    const launched = dwarfs.bind(LAUNCHED, MINE, T0)
    transactions.inTransaction(() => {
      sessions.save({
        identity: OBSERVED,
        dwarfId: observed,
        cwd: MINE,
        firstSeenAt: T0,
        lastRecordAt: T0,
        closedAt: null
      })
      sessions.saveStream({ dwarfId: observed, streamId: 'simulated:observed-1' })
    })

    const queries = createObservationQueries({ sessions })

    expect(queries.observedSessionOf(observed)).toEqual({
      dwarfId: observed,
      streamIds: ['simulated:observed-1']
    })
    expect(queries.observedSessionOf(launched)).toBeNull()
  })
})
