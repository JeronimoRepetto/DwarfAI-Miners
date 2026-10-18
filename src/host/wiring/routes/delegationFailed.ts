// The `DelegationFailed` route (08 §2.8 consumer "conversation"; 05 §4; 07 S8.02, S8.04–S8.07,
// S8.09, S8.11–S8.13; 16 §5.4 "Parent chat line"; 14 §2.4; US-DLG-005; ISSUE-206): one bus
// subscription that gives the parent's own chat exactly one ordinary `system-line` per failed
// delegation, through conversation's public `ingest` (16 §4.6), and nothing else: no toast, no
// Add-panel notice and no notice type of its own (PO #45). The line reaches the UI only as that
// message in `conversation.appended` (14 §2.4).
//
// - Every failure is logged `delegation.failed` with its class only (19 §9.3): the delegation id,
//   the parent's id and the 06 `DelegationFailure`, never the subtask's text (NFR-SEC-12).
// - `parent-gone` has no line (S8.11). Neither has a parent whose session is gone by the time the
//   event is routed (07 §8 `failed`: "when its session is alive"; S8.09): crew no longer holds it
//   present, and its chat cannot receive the line.
// - The text is delegation's (`parentFailureLine`), `<dwarf>` being crew's display name
//   (`customName ?? baseName`, ADR-018 item 9) read when the line is written.
// - The line's natural key is `delegation-failed:<delegationId>`: a replayed event, whatever its
//   event id or time, appends nothing (INV-82; conversation claims the key in `message_keys`).
// - A failing write is logged `delegation.failed-line.failed` and never reaches the publisher.
//
// The Host registers it with the other delegation routes (wiring/delegationWiring.ts, ISSUE-209);
// the in-memory F6 flow harness (flows/testing/delegationHost.ts) composes it the same way.
import type { DiagnosticsLog } from '../../kernel/ports/diagnosticsLog'
import type { DomainEventBus } from '../../kernel/ports/domainEventBus'
import type { ConversationCommands } from '../../modules/conversation'
import type { CrewQueries } from '../../modules/crew'
import { parentFailureLine, type DelegationFailed } from '../../modules/delegation'

export interface DelegationFailedRouteDeps {
  /** The Host's one event bus (16 §2.3). */
  bus: Pick<DomainEventBus<DelegationFailed>, 'subscribe'>
  crew: Pick<CrewQueries, 'get' | 'displayName'>
  conversation: Pick<ConversationCommands, 'ingest'>
  log: DiagnosticsLog
}

/** Registers the route; returns its unsubscribe. */
export function registerDelegationFailed(deps: DelegationFailedRouteDeps): () => void {
  return deps.bus.subscribe('DelegationFailed', ({ payload }) => {
    const { delegationId, parentDwarfId, failure } = payload
    deps.log.record({
      level: 'warn',
      event: 'delegation.failed',
      subsystem: 'delegation',
      outcome: 'failed',
      causeClass: failure,
      delegationId,
      dwarfId: parentDwarfId
    })
    try {
      const parent = deps.crew.get(parentDwarfId)
      if (parent === null || parent.departed) return
      const line = parentFailureLine(payload, deps.crew.displayName(parentDwarfId))
      if (line === null) return
      deps.conversation.ingest(
        line.parentDwarfId,
        [{ sourceKey: line.sourceKey, role: 'system-line', text: line.text, providerTime: null }],
        'live-stream'
      )
    } catch {
      deps.log.record({
        level: 'warn',
        event: 'delegation.failed-line.failed',
        subsystem: 'delegation',
        outcome: 'failed',
        causeClass: failure,
        delegationId,
        dwarfId: parentDwarfId
      })
    }
  })
}
