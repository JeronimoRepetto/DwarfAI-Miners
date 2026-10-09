// A-40 `answerDwarfQuestion` / `agent:answerQuestion` and A-41 `answerDwarfPermission` / `agent:answerPermission`
// dispatched by AskId namespace (21 §3 `LegacyAskRelay`, §3.1 `LegacyAnswerShapeAdapter`; 21 §2 cut 2 "Qualified
// routes": the qualifier is decided by the AskId namespace of `LegacyAskRelay`, never by guessing; 14 §8 I-11).
//
// From cut 2 every ask has exactly one answerer. An answer whose AskId is in the relay's namespace
// `legacy:<legacyAskId>` goes to the legacy shape adapter, which hands it to today's runtime; any other id goes to
// the `host` handler of ISSUE-128 (`answerDwarf.host.ts`), which validates it and relays it to `asking.*`. So a
// `legacy:` id never reaches the broker and a Host id never reaches today's runtime. The decision reads the id
// only: never the dwarf, its provider or its origin. A `legacy:` id is never a UUIDv7 (it holds a colon), so it can
// never pass for a Host `AskId`. The payload goes on unchanged: main mints nothing, the renderer's `requestId`
// included (14 §1.6).
//
// Nothing here logs: A-40's payload carries free-text answers (14 §3.5 SENSITIVE_METHODS).
//
// Built and tested, not routed: the cut-2 switch (later: ISSUE-141) installs the qualified routes and the root
// composes this dispatch with `createAnswerDwarfRows` and the bridge's `LegacyAnswerShapeAdapter`. It lives while
// `LegacyAskRelay` does: deleted with it at the end of cut 4 (later: ISSUE-241), when A-40/A-41 are `host` only.
//
// Candidate decision (21 §6): no candidate exists; new code.
import type { RouteTarget } from '../router'

/** The AskId namespace of `LegacyAskRelay` (21 §3). The bridge owns the same prefix (`LEGACY_ASK_NAMESPACE`). */
export const LEGACY_ASK_NAMESPACE = 'legacy:'

/** Whether `askId` names a legacy ask: `legacy:` followed by today's non-empty ask id. */
export function isLegacyAskId(askId: unknown): boolean {
  return (
    typeof askId === 'string' &&
    askId.startsWith(LEGACY_ASK_NAMESPACE) &&
    askId.length > LEGACY_ASK_NAMESPACE.length
  )
}

export function createAnswerDwarfDispatch(deps: {
  /** The A-40/A-41 `host` handlers (`createAnswerDwarfRows`, ISSUE-128). */
  host: RouteTarget
  /** The bridge's `LegacyAnswerShapeAdapter` (21 §3.1). */
  legacy: RouteTarget
}): RouteTarget {
  return {
    serve(channel, payload, sender) {
      const askId = (payload as { askId?: unknown } | null | undefined)?.askId
      const owner = isLegacyAskId(askId) ? deps.legacy : deps.host
      return owner.serve(channel, payload, sender)
    }
  }
}
