import { describe } from 'vitest'
import { runStopAllContract } from '../kernel/testing/stopAll.contract'
import { emptyOwnerStopAll } from './emptyOwnerStopAll'

// Cut 0: the Host owns no session yet (ADR-002 D7; ISSUE-029), so the binding owns none.
describe('emptyOwnerStopAll', () => {
  runStopAllContract(() => ({ port: emptyOwnerStopAll, owned: [] }))
})
