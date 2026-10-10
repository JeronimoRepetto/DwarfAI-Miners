// Driven port: the read `AskBroker.open` needs to resolve a request's emission (ADR-011 item 5;
// 16 §4.7 row `open`): for the dwarf the caller resolved, whether the app launched its session or
// only observes it, and the session's effective ADR-009 D2 capabilities for asks. Type-only (05 R2).
//
// Bound in `host/wiring` to suppliers' capability data (ISSUE-147: the merged ceiling and
// negotiated set, the OpenCode answer-channel gate applied) along the asking → suppliers edge
// (05 §1.3); that binding is later: ISSUE-140. The binding answers for every dwarf it is asked
// about: a dwarf with no capability record reads suppliers' fail-closed capabilities (every answer
// path `none`), so no request ever gets a card the app cannot honour. `FakeSessionCapabilities`
// is the double.
//
// `providerId` is carried for diagnostics only: the broker never branches on it (R12, TC-132-03).
import type { DwarfId } from '../../../kernel/domain/values'
import type { ProviderCapabilities } from '../../suppliers'
import type { EmissionSession } from '../domain/emission'

/** The capabilities an ask's emission reads (ADR-009 D2 field names and types). */
export type AskCapabilities = Pick<
  ProviderCapabilities,
  'permission' | 'question' | 'observedPermission' | 'observedQuestion'
>

/** The session a dwarf's request came from. */
export interface AskSession {
  readonly providerId: string
  readonly origin: EmissionSession['origin']
  readonly capabilities: AskCapabilities
}

export interface SessionCapabilities {
  /** The dwarf's session as its asks see it; fail-closed capabilities when nothing is recorded. */
  sessionOf(dwarfId: DwarfId): AskSession
}

/**
 * Compile-time check that the owner's capability types still fit the domain's structural copy
 * (`domain/emission.ts`): a change to ADR-009 D2's fields fails typecheck here.
 */
export type CapabilitiesFitEmission = Holds<
  AskCapabilities extends Omit<EmissionSession, 'origin'> ? true : false
>
type Holds<T extends true> = T
