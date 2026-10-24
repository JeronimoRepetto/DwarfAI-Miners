// layer: L2
// L2 (17 §1.2): observation's read for the observed-subagent route (AMENDMENT-29): a dwarf known by
// the identity of its last batch is asked of each adapter that can tell a subagent's lead terminal,
// in order; a dwarf it does not know, or that no adapter answers, has none.
import { describe, expect, it } from 'vitest'
import type { ProcessIdentity } from '../../../kernel/domain/processIdentity'
import type { DwarfId, ProviderIdentity } from '../../../kernel/domain/values'
import {
  observedSubagentConsoles,
  type ObservedSubagentConsoleRegistry,
  type ObservedSubagentSendFacts
} from './subagentConsoles'

const DWARF = '00000000-0000-7000-8000-0000000000e1' as DwarfId
const OTHER = '00000000-0000-7000-8000-0000000000e2' as DwarfId
const LEAD: ProcessIdentity = { pid: 4242, processStartTimeMs: 1, bootId: 'b' }
const SUBAGENT: ProviderIdentity = {
  providerId: 'claude',
  providerSessionId: 's-1',
  providerAgentId: 'a1'
}
const FACTS: ObservedSubagentSendFacts = {
  lead: LEAD,
  description: 'Run ping five times (echo)',
  twins: 0,
  version: '2.1.310'
}

function registry(
  answers: { lead: ProcessIdentity | null; facts: ObservedSubagentSendFacts | null },
  asked: ProviderIdentity[] = []
): ObservedSubagentConsoleRegistry {
  return {
    leadProcessOf: (identity) => {
      asked.push(identity)
      return answers.lead
    },
    subagentSendFactsOf: async (identity) => {
      asked.push(identity)
      return answers.facts
    }
  }
}

describe('observedSubagentConsoles (AMENDMENT-29)', () => {
  it("[ADR-014] a known dwarf's identity is asked of each adapter in order, the first answer wins", async () => {
    const asked: ProviderIdentity[] = []
    const consoles = observedSubagentConsoles(
      (dwarfId) => (dwarfId === DWARF ? SUBAGENT : null),
      [registry({ lead: null, facts: null }, asked), registry({ lead: LEAD, facts: FACTS })]
    )
    expect(consoles.leadProcessOf(DWARF)).toEqual(LEAD)
    expect(await consoles.subagentSendFactsOf(DWARF)).toEqual(FACTS)
    expect(asked).toEqual([SUBAGENT, SUBAGENT])
  })

  it('[ADR-014] a dwarf observation does not know, or that no adapter answers, has none', async () => {
    const asked: ProviderIdentity[] = []
    const consoles = observedSubagentConsoles(
      (dwarfId) => (dwarfId === DWARF ? SUBAGENT : null),
      [registry({ lead: null, facts: null }, asked)]
    )
    expect(consoles.leadProcessOf(OTHER)).toBeNull()
    expect(await consoles.subagentSendFactsOf(OTHER)).toBeNull()
    expect(asked).toEqual([])
    expect(consoles.leadProcessOf(DWARF)).toBeNull()
    expect(await consoles.subagentSendFactsOf(DWARF)).toBeNull()
    expect(observedSubagentConsoles(() => SUBAGENT, []).leadProcessOf(DWARF)).toBeNull()
  })
})
