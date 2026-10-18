// layer: L2
import { runCandidateLoginEntryContract } from '../candidateLoginEntry.contract'
import { FakeCandidateLoginEntry } from './FakeCandidateLoginEntry'

runCandidateLoginEntryContract('FakeCandidateLoginEntry', () => {
  const entry = new FakeCandidateLoginEntry()
  return {
    entry,
    starts: async () => entry.entry,
    refuseWrites: () => (entry.refuse = true),
    seedLegacy: () => (entry.legacyEntry = true),
    legacy: async () => entry.legacyEntry
  }
})
