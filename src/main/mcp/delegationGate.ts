import type { DwarfProvider } from '../domain/types'

/**
 * Whether a launched session may be handed the MCP server that lets it
 * delegate a subtask back through Jev (#511).
 *
 * Three independent gate levels, ALL required (user decision, 2026-09-22):
 *
 * 1. `keyConfigured` — a TypeSafe API key is actually set. No key, no Jev at
 *    all, so there is nothing for a delegated subtask to be routed by.
 * 2. `delegation` — Settings' own checkbox (`JevPreferences.delegation`),
 *    off by default. A key being configured only turns Jev ON for a launch;
 *    it says nothing about whether a RUNNING session may reach back out on
 *    its own, which is a materially bigger grant than routing one launch.
 * 3. `routedByJev` — THIS launch was itself routed by an applied Jev
 *    decision, never a fallback (see `AgentLaunchRequest.routedByJev`'s own
 *    comment in `contracts.ts`). A session started on the person's own
 *    pickers, with Jev merely available, has not earned the server either —
 *    the gate is evaluated per launch, not once per app.
 *
 * All three are necessary and none is sufficient alone: a configured key
 * with the checkbox off must not delegate, a checked box with no key
 * configured has nothing to route through, and a routed launch with the
 * checkbox off is still declined. Auto-accept (the #523 checkbox beside the
 * Jev toggle) plays no part in any of this — it only decides how fast a
 * PICKER commits, never what a running session may do.
 *
 * Evaluated at launch time, main-side only: nothing here reaches into the
 * renderer, and nothing about the gate is drawn — see `Dwarf.routedByJev`'s
 * own comment on why the marker is a separate, later concern from this.
 */
export interface DelegationGateInput {
  keyConfigured: boolean
  delegation: boolean
  routedByJev: boolean
  provider: DwarfProvider
}

/**
 * Providers this build can register the delegation server for (#511).
 *
 * Codex is deliberately absent pending one measurement: whether
 * `-c mcp_servers.jev.command=…` actually registers a server on a plain
 * `codex exec` at all is unmeasured (`codex -c … mcp list`, read-only,
 * still to run) — see the Evidence section of the feature document. A build
 * that guessed here could hand a session a tool call that silently does
 * nothing, which is worse than the tool never appearing.
 *
 * Antigravity is excluded for a different reason, and is not waiting on a
 * measurement: only a global (`~/.gemini/config/mcp_config.json`) or
 * project-local (`.agents/mcp_config.json`) file is documented for it, with
 * no per-invocation flag this app could inject through — and writing a
 * server registration into the user's own project file, on their behalf,
 * was decided against (#511, #512).
 */
export const DELEGATION_CAPABLE_PROVIDERS: readonly DwarfProvider[] = ['claude', 'opencode']

export function delegationEnabledFor(input: DelegationGateInput): boolean {
  return (
    input.keyConfigured &&
    input.delegation &&
    input.routedByJev &&
    DELEGATION_CAPABLE_PROVIDERS.includes(input.provider)
  )
}
