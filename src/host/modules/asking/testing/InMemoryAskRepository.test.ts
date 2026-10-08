import { describe } from 'vitest'
import type { DwarfId } from '../../../kernel/domain/values'
import { InMemoryAskRepository, InMemoryAskRows } from '../ports/fakes/InMemoryAskRepository'
import { runAskRepositoryContract } from './askRepository.contract'

// L3 (17 §1.3): the double runs the same contract as the SQLite adapter. Its "database" is an
// `InMemoryAskRows`; a reopen is a new repository over the same rows.
describe('InMemoryAskRepository', () => {
  runAskRepositoryContract(() => {
    const rows = new InMemoryAskRows()
    return {
      repository: new InMemoryAskRepository(rows),
      dwarfs: ['dwarf-0001' as DwarfId, 'dwarf-0002' as DwarfId],
      inTransaction: (work) => work(),
      reopen: () => new InMemoryAskRepository(rows),
      dispose: () => undefined
    }
  })
})
