// B-M38 `jev.suggest` (14 §2.3, §3.4 `JevSuggestParams`/`JevSuggestResult`, frozen; 16 §4.9): the
// suggestion behind the Add panel's Jev card, asked with the prompt as typed (`purpose: 'launch'`).
// UI main's A-50 relays it (the route switch of step 3a, later: ISSUE-001); the Host composition
// root registers it over the wired jev module (later: ISSUE-196).
//
// - Roles (roles.ts): `ui` only; a `notifier` or `viewer` gets FORBIDDEN before the handler runs.
// - A query (14 §1.6): no requestId, no effect, no frame, never stored (INV-87).
// - The params are the contract's strict() schema (ADR-019); any other key or type is
//   INVALID_PARAMS before the handler runs.
// - Only the prompt reaches the advisor (16 §6.2; C-26): the `mineId` is the renderer's correlation
//   and never leaves the Host.
// - Lead decision (ISSUE-192, 2026-09-30): seam B has no member that dismisses a suggestion, so a
//   new call from the same connection aborts that connection's previous in-flight call (a changed
//   prompt, 16 §6.5), which answers no suggestion; the renderer drops a late result after Dismiss
//   or an emptied prompt (later: ISSUE-195). Another connection's call is never touched.
// - Nothing here logs: the prompt is sensitive (14 §3.5 SENSITIVE_METHODS `jev.suggest: 'params'`),
//   and the dispatcher logs the method name only (14 §1.10).
import { HOST_METHOD_SCHEMAS, type JevSuggestResult } from '@dwarfai/contracts'
import type { AbortableJevAdvisor } from '../../modules/jev'
import type { Dispatcher } from '../dispatcher'
import { METHOD_ROLES } from '../roles'

export interface JevSuggestDeps {
  advisor: Pick<AbortableJevAdvisor, 'suggest'>
}

/** Serves `jev.suggest` (B-M38) on `dispatcher`. */
export function registerJevSuggest(dispatcher: Dispatcher, deps: JevSuggestDeps): void {
  /** The in-flight call of each connection, by `clientId`. */
  const inFlight = new Map<string, AbortController>()
  dispatcher.register(
    'jev.suggest',
    HOST_METHOD_SCHEMAS['jev.suggest'].params,
    METHOD_ROLES['jev.suggest'] ?? [],
    async (params, context): Promise<JevSuggestResult> => {
      inFlight.get(context.clientId)?.abort()
      const controller = new AbortController()
      inFlight.set(context.clientId, controller)
      try {
        const answer = await deps.advisor.suggest(
          { prompt: params.prompt, purpose: 'launch' },
          { signal: controller.signal }
        )
        // 14 §3.4 `JevSuggestResult`: the error alone; the fallback reason the advisor names for a
        // launch's `jev_reason` (ISSUE-182) is Host-internal and never sent.
        return answer.ok ? answer : { ok: false, error: answer.error }
      } finally {
        if (inFlight.get(context.clientId) === controller) inFlight.delete(context.clientId)
      }
    }
  )
}
