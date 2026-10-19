// The EndedAgentLedger conformance suite (16 §4.3 `runEndedAgentLedgerContract`; 17 §1.3): run on
// `InMemoryEndedAgentLedger` and on `SqliteEndedAgentLedger`. An identity joins once (the identity
// is the key, 09 §4.2), a second record answers `duplicate` and changes nothing, `record` runs
// only inside the caller's transaction and rolls back with it, and an ended identity never
// re-arrives: `has` answers true from then on, for that identity only (16 §4.3 "an ended identity
// never re-arrives").
import { describe, expect, it } from 'vitest'
import type { ProviderIdentity } from '../../../kernel/domain/values'
import type { EndedAgentLedger } from '../ports/endedAgentLedger'

export interface EndedAgentLedgerSubject {
  ledger: EndedAgentLedger
  /** The caller's transaction: commits when `work` returns, rolls back when it throws. */
  inTransaction<T>(work: () => T): T
}

const T0 = 1_790_000_000_000
const SESSION: ProviderIdentity = { providerId: 'claude', providerSessionId: 'session-1' }
const AGENT: ProviderIdentity = { ...SESSION, providerAgentId: 'a0000000000000001' }

export function runEndedAgentLedgerContract(makeSubject: () => EndedAgentLedgerSubject): void {
  describe('EndedAgentLedger contract', () => {
    it('[INV-36] recording an identity twice answers duplicate and has answers true', () => {
      const { ledger, inTransaction } = makeSubject()
      expect(ledger.has(AGENT)).toBe(false)
      expect(inTransaction(() => ledger.record(AGENT, T0))).toBe('new')
      expect(inTransaction(() => ledger.record(AGENT, T0 + 5_000))).toBe('duplicate')
      expect(ledger.has(AGENT)).toBe(true)
    })

    it('[INV-36] an ended subagent is its own identity: its session and its siblings are not ended', () => {
      const { ledger, inTransaction } = makeSubject()
      inTransaction(() => ledger.record(AGENT, T0))
      expect(ledger.has(SESSION)).toBe(false)
      expect(ledger.has({ ...SESSION, providerAgentId: 'a0000000000000002' })).toBe(false)
      expect(ledger.has({ ...AGENT, providerId: 'codex' })).toBe(false)

      inTransaction(() => ledger.record(SESSION, T0))
      expect(ledger.has(SESSION)).toBe(true)
      expect(ledger.has(AGENT)).toBe(true)
    })

    it('[INV-36] a record rolled back with its transaction leaves the identity not ended', () => {
      const { ledger, inTransaction } = makeSubject()
      expect(() =>
        inTransaction(() => {
          ledger.record(AGENT, T0)
          throw new Error('the batch failed')
        })
      ).toThrow('the batch failed')
      expect(ledger.has(AGENT)).toBe(false)
    })

    it('[INV-36] record outside the caller transaction throws and records nothing', () => {
      const { ledger } = makeSubject()
      expect(() => ledger.record(AGENT, T0)).toThrow(/inside the caller transaction/)
      expect(ledger.has(AGENT)).toBe(false)
    })
  })
}
