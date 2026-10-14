// The route qualifier of A-40 `answerDwarfQuestion` / `agent:answerQuestion` and A-41 `answerDwarfPermission` /
// `agent:answerPermission` (21 §1 item 2; 21 §2 cut 2 "Qualified routes": the qualifier is decided by the AskId namespace
// of `LegacyAskRelay`, never by guessing; 21 §3, §3.1; 14 §8 I-11).
//
// From cut 2 every ask has exactly one answerer, and the route table says which (`routes.ts`, ISSUE-141): A-40/A-41
// route `host` unqualified, and `legacy` through `LegacyAnswerShapeAdapter` for each origin of the relay's namespace.
// This reads one call's payload and answers its qualifier: an AskId in the namespace `legacy:<legacyAskId>` carries the
// relay's origin of that ask (`legacy-launch` for an ask of a session today's runtime launched and holds,
// `legacy-ask-channel` for one it reads for a session it did not launch, such as an observed Codex question); any other
// id carries none, so the unqualified `host` route answers it (its handler, `answerDwarf.host.ts`, validates it and
// relays it to `asking.*`). So a `legacy:` id never reaches the broker and a Host id never reaches today's runtime. A
// `legacy:` id the relay does not hold now still names a legacy ask: it is qualified `legacy-ask-channel`, and the shape
// adapter answers it `not-open` (ADR-010 stale drop) without calling today's runtime. The decision reads the id only:
// never the dwarf or its provider. A `legacy:` id is never a UUIDv7 (it holds a colon), so it can never pass for a Host
// `AskId`. The payload goes on unchanged: main mints nothing, the renderer's `requestId` included (14 §1.6).
//
// Nothing here logs: A-40's payload carries free-text answers (14 §3.5 SENSITIVE_METHODS).
//
// AMENDED for ISSUE-141 (lead decision 2026-10-14, was: `createAnswerDwarfDispatch`, one `host` target that split each
// call between the `host` handlers and the shape adapter): the route table dispatches the qualified rows itself, so only
// the qualifier stays here. The origin lookup is the relay's, handed in by the composition root (only it may compose the
// bridge, R16). It lives while `LegacyAskRelay` does: deleted with it at the end of cut 4 (later: ISSUE-241), when
// A-40/A-41 are `host` only.
//
// Candidate decision (21 §6): no candidate exists; new code.
import type { RouteQualifier } from '../channelRoute'

/** The AskId namespace of `LegacyAskRelay` (21 §3). The bridge owns the same prefix (`LEGACY_ASK_NAMESPACE`). */
export const LEGACY_ASK_NAMESPACE = 'legacy:'

/** Whether `askId` names a legacy ask: `legacy:` followed by today's non-empty ask id. */
export function isLegacyAskId(askId: unknown): askId is string {
  return (
    typeof askId === 'string' &&
    askId.startsWith(LEGACY_ASK_NAMESPACE) &&
    askId.length > LEGACY_ASK_NAMESPACE.length
  )
}

/** The relay's origin of an ask (`RelayedLegacyAsk.origin`). */
export type LegacyAskOrigin = NonNullable<RouteQualifier['origin']>

/**
 * The A-40/A-41 qualifier: `{ origin }` of the relay's ask for a `legacy:` AskId (`legacy-ask-channel` when the relay
 * holds no such ask now), none for any other AskId.
 */
export function createAnswerQualifier(deps: {
  /** The relay's origin of the open ask `askId`, or undefined when it holds none. */
  originOf(askId: string): LegacyAskOrigin | undefined
}): (payload: unknown) => RouteQualifier {
  return (payload) => {
    const askId = (payload as { askId?: unknown } | null | undefined)?.askId
    if (!isLegacyAskId(askId)) return {}
    return { origin: deps.originOf(askId) ?? 'legacy-ask-channel' }
  }
}
