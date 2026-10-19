import { describe } from 'vitest'
import type { DwarfId, MineId } from '../../../kernel/domain/values'
import { inMemoryLaunching } from './inMemoryLaunching'
import { runLaunchRecordStoreContract } from './launchRecordStore.contract'
import { runLaunchStoreContract } from './launchStore.contract'
import { runProcessRecordStoreContract } from './processRecordStore.contract'

// L3 (17 §1.3): the launching store doubles run the same contracts as the SQLite adapters.
describe('InMemoryLaunchStore', () => {
  runLaunchStoreContract(() => {
    const { clock, launches, inTransaction } = inMemoryLaunching()
    return {
      store: launches,
      clock,
      mineId: '00000000-0000-7000-8000-0000000161f1' as MineId,
      delegation: {
        delegationId: '00000000-0000-7000-8000-0000000161de',
        parentDwarfId: '00000000-0000-7000-8000-0000000161d0' as DwarfId
      },
      dwarfId: '00000000-0000-7000-8000-0000000161d1' as DwarfId,
      settledAt: (id) => launches.settledAt(id),
      seenAt: (id) => launches.seenAt(id),
      inTransaction,
      dispose: () => undefined
    }
  })
})

describe('InMemoryLaunchRecordStore', () => {
  runLaunchRecordStoreContract(() => {
    const { records, processes, inTransaction } = inMemoryLaunching()
    return {
      store: records,
      processes,
      owned: () => undefined,
      inTransaction,
      dispose: () => undefined
    }
  })
})

describe('InMemoryProcessRecordStore', () => {
  runProcessRecordStoreContract(() => {
    const { clock, processes, inTransaction } = inMemoryLaunching()
    return {
      store: processes,
      clock,
      launchId: '00000000-0000-7000-8000-0000000161a1' as never,
      inTransaction,
      dispose: () => undefined
    }
  })
})
