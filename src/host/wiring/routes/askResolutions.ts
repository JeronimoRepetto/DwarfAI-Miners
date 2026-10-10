// The observed ask-resolution route (05 §4 row `ObservedAskClosed` / driver `ask.resolved` → asking
// `resolveExternally`; 08 §2.3; ADR-010 item 10; ISSUE-136): one bus subscription that turns an
// observed ask's trusted resolution signal into the broker's external resolution, through the
// target module's public API only (R4, R15).
//
// - The session is resolved to its dwarf through observation's `ProviderIdentity → DwarfId` index
//   (16 §4.3 `ObservedSessionStore.byIdentity`), the route's one lookup; then
//   `resolveExternally(dwarfId, providerRequestId, by)`, which is channel-neutral and terminal once
//   (`(dwarfId, providerRequestId)` is the idempotency key, 08 §2.3): a repeat, an unknown request
//   or an ask already closed changes nothing. The card disappears with no notice (PO #22).
// - A session no dwarf carries has no ask to close (an ask opens only for a dwarf, 16 §4.7 row
//   `open`): the signal is ignored and logged `asking.observed-resolution.unknown-session` with
//   the provider only, never the session or request id (ADR-026). A failing resolution is logged
//   `asking.observed-resolution.failed` and never reaches the publisher.
//
// Producers (none yet): no observation adapter publishes `ObservedAskClosed` today. The observed
// Claude path reports its resolutions through the hook route (observedClaudeAsks.ts, ISSUE-134);
// OpenCode's answered-elsewhere signal waits on SP-09 (ISSUE-229), and until it passes OpenCode
// reports `answeredElsewhere: false` (21 §9). Driver `ask.resolved` joins in EPIC-10. Composed into
// the Host's main by ISSUE-140 (later), with closing by death (`closeForDwarf`).
import type { DiagnosticsLog } from '../../kernel/ports/diagnosticsLog'
import type { DomainEventBus } from '../../kernel/ports/domainEventBus'
import type { AskBroker } from '../../modules/asking'
import type { ObservedAskClosed, ObservedSessionStore } from '../../modules/observation'

export interface AskResolutionsDeps {
  /** The Host's one event bus (16 §2.3). */
  bus: Pick<DomainEventBus<ObservedAskClosed>, 'subscribe'>
  /** Observation's `ProviderIdentity → DwarfId` index (16 §4.3). */
  sessions: Pick<ObservedSessionStore, 'byIdentity'>
  asks: Pick<AskBroker, 'resolveExternally'>
  log: DiagnosticsLog
}

/** Registers the route; returns its unsubscribe. */
export function registerAskResolutions(deps: AskResolutionsDeps): () => void {
  return deps.bus.subscribe('ObservedAskClosed', ({ payload }) => {
    const { identity, providerRequestId, by } = payload
    try {
      const dwarfId = deps.sessions.byIdentity(identity)?.dwarfId ?? null
      if (dwarfId === null) {
        deps.log.record({
          level: 'info',
          event: 'asking.observed-resolution.unknown-session',
          subsystem: 'asking',
          provider: identity.providerId
        })
        return
      }
      deps.asks.resolveExternally(dwarfId, providerRequestId, by)
    } catch {
      deps.log.record({
        level: 'warn',
        event: 'asking.observed-resolution.failed',
        subsystem: 'asking',
        provider: identity.providerId
      })
    }
  })
}
