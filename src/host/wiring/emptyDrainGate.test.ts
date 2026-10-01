import { describe } from 'vitest'
import { runDrainGateContract } from '../kernel/testing/drainGate.contract'
import { emptyDrainGate } from './emptyDrainGate'

// Cut 0: no session exists, so nothing holds the drain (ADR-002 D8; lead decision in ISSUE-032).
describe('emptyDrainGate', () => {
  runDrainGateContract(() => ({ gate: emptyDrainGate, open: [] }))
})
