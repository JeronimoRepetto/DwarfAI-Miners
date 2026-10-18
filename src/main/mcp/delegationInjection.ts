/**
 * What one launch handed its own MCP config builder (#511 T4): the resolved
 * server command (`delegationServerCommand.ts`) and the token this launch's
 * own `issueLaunchToken` call minted (`delegationService.ts`).
 *
 * AMENDED for ISSUE-239, the step-4b deletion (was: also the per-provider
 * pure injection builders, the last of them `mergeOpenCodeConfigContent`,
 * which merged a delegation server entry, token included, into the launched
 * OpenCode CLI's `OPENCODE_CONFIG_CONTENT`; 21 §8 blocker, C-23): today's
 * OpenCode launch left the tree, and with it every builder. Only this type
 * stays, because today's runtime still names it until it goes whole with
 * ISSUE-243 (foreman decision D3). ISSUE-184 and ISSUE-185 had deleted
 * Claude's and Codex's builders.
 */
export interface DelegationInjectionContext {
  /** `process.execPath` in production — see `delegationServerCommand.ts`. */
  serverCommand: string
  /** The one argv element naming the built `jevMcpServer.js` script path. */
  serverArgs: readonly string[]
  /** `http://127.0.0.1:<port>` — this launch's own delegation service origin. */
  endpoint: string
  /** This launch's own per-parent shared secret (`DelegationTokenRegistry.issue`). */
  token: string
  /** Overrides `DEFAULT_DELEGATION_WAIT_MS` for this launch; absent leaves the server's own default. */
  waitMs?: number
}
