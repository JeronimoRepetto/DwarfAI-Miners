// Driven port of observation (05 §3.3, 16 §4.3 `EndedAgentLedger`): the provider identities
// DwarfAI ended or saw end, over `ended_agents` (09 §4.2; ADR-029 §B, ADR-014 item 7). Whatever
// path ended an identity (an adapter's terminal notification, the terminator's record through
// `ObservationControl.recordEnded`), it joins here once, and the observation loop never lets it
// arrive again (INV-36; 07 S4.30 guard, S3.22, S4.40). Rows are kept by Reset metrics (09 §7.2).
// `record` runs inside the caller's transaction (16 §2.2). Type-only (05 §2.2).
//
// The interface below is 16 §4.3's, member for member.
import type { Instant, ProviderIdentity } from '../../../kernel/domain/values'

export interface EndedAgentLedger {
  // ended_agents (ADR-029 §B, ADR-014 item 7): identities DwarfAI ended or saw end
  has(i: ProviderIdentity): boolean
  record(i: ProviderIdentity, at: Instant): 'new' | 'duplicate'
}
