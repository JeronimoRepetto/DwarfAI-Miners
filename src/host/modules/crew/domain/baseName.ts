// A dwarf's base name (06 §5.1 `baseName`): agent-facing, never overridden, and the only name
// provider-bound text uses (NFR-PRIV-03). Pure: no I/O, no clock read (R1).
import type { ProviderIdentity } from '../../../kernel/domain/values'

/** Characters of the session or subagent id the base name keeps. */
const ID_PREFIX_LENGTH = 8

/**
 * The provider id and the start of the subagent id, or of the session id for a root session. Built
 * from the provider identity alone, never from the DwarfAI id (INV-20) and never from a provider id
 * literal (R12), so every provider of the open catalog gets one the same way.
 */
export function baseNameFor(identity: ProviderIdentity): string {
  const own =
    identity.providerAgentId !== undefined && identity.providerAgentId !== ''
      ? identity.providerAgentId
      : identity.providerSessionId
  return `${identity.providerId}-${own.slice(0, ID_PREFIX_LENGTH)}`
}
