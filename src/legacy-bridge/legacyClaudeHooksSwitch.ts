// Today's Claude hook half, switched off at the cut-2 switch (ISSUE-141; 21 §2 cut 2 "Switched off in legacy"; 21 §1
// item 4; 21 §4 row "Claude hook entry"; TC-141-06). From cut 2 the Host's `ClaudeHooksConfigWriter` is the only writer
// of the Claude hook entry and the Host's ingress its only reader, so `LegacyRuntimeRoute` composes neither today's
// `HookChannel` (the hook installer: its `restore()` would reinstall today's entry for a person who opted in with the
// old app) nor the Claude route of today's loopback listener, whose events fed today's observed-Claude permission
// registry and so its keystroke path (`runtime.noteHookEvent`). The listener itself stays composed for the OpenCode
// plugin route until 4a; a call from an old-app Claude hook entry finds no Claude route there (a closed route answers
// 404, and with no route open the port is not bound), which Claude Code treats as a non-blocking hook failure.
//
// The switch is the route table's: the root passes `legacyClaudeHooksComposed(ROUTES)` (src/ui-main/index.ts), true
// only while A-40 and A-41 keep their pre-cut-2 routes, so a cut-2 rollback build composes today's half again (21 §2.1).
// The cut-2 retirement (later: ISSUE-142) deletes the composition this gates, after the soak (OQ-71).
//
// Candidate decision (21 §6): today's composition (`LegacyRuntimeRoute.ts`) is KEPT; this switch is new code. Deleted
// with the cut-2 retirement.
import type { HookEvent } from '../main/hooks/hookPayload'

/** Today's Claude hook half as `LegacyRuntimeRoute` composes it. */
export interface LegacyClaudeHookComposition<H> {
  /** Today's `HookChannel` (installer and restore), or null when switched off. */
  hooks: H | null
  /** The shared listener's `onEvent`: today's runtime's, or a sink that drops every Claude event. */
  onEvent(event: HookEvent): void
}

/** Composes today's Claude hook half only when `composed` (the route table's switch). */
export function legacyClaudeHookComposition<H>(
  composed: boolean,
  parts: {
    /** Today's runtime hearing a Claude hook event (`noteHookEvent`, then a nudge). */
    onHookEvent(event: HookEvent): void
    /** Builds today's `HookChannel`; never called when switched off. */
    hookChannel(): H
  }
): LegacyClaudeHookComposition<H> {
  if (!composed) return { hooks: null, onEvent: () => {} }
  return { hooks: parts.hookChannel(), onEvent: (event) => parts.onHookEvent(event) }
}
