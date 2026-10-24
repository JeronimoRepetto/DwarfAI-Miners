// Observation's read for the observed-subagent route (AMENDMENT-29, owner 2026-10-24): for a dwarf
// that is an observed subagent, its lead session's terminal as the adapters can tell it. Like
// `ObservedProcessIdentities` (index.ts), a dwarf is known by the identity of the last batch written
// to it this Host run, and each adapter that can answer (the Claude adapter) is asked in order; the
// first answer wins. Package gap, kept off the frozen `ObservationQueries` (16 §4.3), as the process
// identity read is: the route is a Host-internal adapter (AMENDMENT-29 "Contract shapes").
import type { ProcessIdentity } from '../../../kernel/domain/processIdentity'
import type { DwarfId, ProviderIdentity } from '../../../kernel/domain/values'

/** What the subagent route needs of a subagent dwarf (`ClaudeSubagentConsoleSend`). */
export interface ObservedSubagentSendFacts {
  /** The lead session's process identity as observation recorded it (ADR-014 item 2). */
  lead: ProcessIdentity
  /** The subagent's `description` (the rule label of its view), or null when it names none. */
  description: string | null
  /** How many other subagents of the session, not seen to end, carry the same description. */
  twins: number
  /** The provider CLI version the session's latest record names, or null. */
  version: string | null
}

/** An adapter's read of a subagent's lead terminal, by provider identity. */
export interface ObservedSubagentConsoleRegistry {
  leadProcessOf(identity: ProviderIdentity): ProcessIdentity | null
  subagentSendFactsOf(identity: ProviderIdentity): Promise<ObservedSubagentSendFacts | null>
}

/** The same read, by dwarf. */
export interface ObservedSubagentConsoles {
  /** The lead session's process identity of a subagent dwarf, or null (sync: crew's INV-33 read). */
  leadProcessOf(dwarfId: DwarfId): ProcessIdentity | null
  /** The facts of a subagent dwarf, read fresh, or null. */
  subagentSendFactsOf(dwarfId: DwarfId): Promise<ObservedSubagentSendFacts | null>
}

export function observedSubagentConsoles(
  identityOf: (dwarfId: DwarfId) => ProviderIdentity | null,
  registries: readonly ObservedSubagentConsoleRegistry[]
): ObservedSubagentConsoles {
  return {
    leadProcessOf: (dwarfId) => {
      const identity = identityOf(dwarfId)
      if (identity === null) return null
      for (const registry of registries) {
        const lead = registry.leadProcessOf(identity)
        if (lead !== null) return lead
      }
      return null
    },
    subagentSendFactsOf: async (dwarfId) => {
      const identity = identityOf(dwarfId)
      if (identity === null) return null
      for (const registry of registries) {
        const facts = await registry.subagentSendFactsOf(identity)
        if (facts !== null) return facts
      }
      return null
    }
  }
}
