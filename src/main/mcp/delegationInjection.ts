// Runtime values come from the main-only twin, never `./delegationProtocol`
// directly (#511 T4) — see `delegationServerProtocol.ts`'s own top comment
// for why: THIS module is a runtime dependency of `index.js`'s build graph
// (via `sdkHeldSession.ts`/`launchRunner.ts`), and `delegationProtocol.ts` is
// ALSO a runtime dependency of `jevMcpServer.js`'s own graph — importing a
// runtime value from it here reproduced the exact regression that file's
// comment describes: a fresh `out/main/chunks/delegationProtocol-*.js` that
// `jevMcpServer.js` then imported, breaking the single self-contained script
// `electron.vite.config.ts` promises. `DelegationInjectionContext` needs no
// such import at all — it is this module's own type.
import {
  DELEGATE_SUBTASK_TOOL_NAME,
  DELEGATION_ENDPOINT_ENV,
  DELEGATION_TOKEN_ENV,
  DELEGATION_WAIT_MS_ENV,
  SUBTASK_RESULT_TOOL_NAME
} from './delegationServerProtocol'

/**
 * Per-provider pure injection builders (#511 T4) — argv fragments, env maps
 * and config-file bodies only. Nothing here spawns a process, writes a file,
 * evaluates the gate (`delegationGate.ts`) or issues a token
 * (`delegationService.ts`); it only says what bytes a provider's own
 * per-invocation MCP mechanism needs, given a token already issued and a
 * resolved server command already in hand. Wired into the launch paths in
 * `sessionLaunch/sdkHeldSession.ts` (Claude held), `sessionLaunch/launchRunner.ts`
 * (Claude `-p`, OpenCode) and `runtime.ts` (the gate check and token
 * lifecycle) — see each for how a `DelegationInjectionContext` is built and
 * when it is revoked.
 */

/**
 * What one launch needs to hand its own MCP config builder: the resolved
 * server command (`delegationServerCommand.ts`) and the token this launch's
 * own `issueLaunchToken` call minted (`delegationService.ts`). Everything
 * else here is a pure function of this one shape.
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

/**
 * The one MCP server name every provider registers the delegation tools
 * under — `mcp__jev__<tool>` is the wire spelling every CLI's own tool-name
 * convention (`mcp__<server>__<tool>`) produces from it.
 */
export const DELEGATION_SERVER_NAME = 'jev'

function wireToolName(tool: string): string {
  return `mcp__${DELEGATION_SERVER_NAME}__${tool}`
}

/**
 * The two tools a delegating session needs pre-approved (#511 T4's own
 * permission decision — see `sdkHeldSession.ts` and `launchRunner.ts` for
 * where each is actually applied): `delegate_subtask` and `subtask_result`,
 * and nothing else. Naming exactly these two, rather than every
 * `mcp__jev__*` tool, keeps the grant as narrow as the server's own surface —
 * there is no third tool today, but a future one would need its own line
 * here rather than inheriting approval by wildcard.
 */
export const DELEGATION_ALLOWED_TOOLS: readonly [string, string] = [
  wireToolName(DELEGATE_SUBTASK_TOOL_NAME),
  wireToolName(SUBTASK_RESULT_TOOL_NAME)
]

/**
 * The env every provider's own MCP server entry carries (#511 T4) — the
 * three loopback vars `delegationProtocol.ts` (T2) already fixed, PLUS
 * `ELECTRON_RUN_AS_NODE`, which belongs here rather than on the launched
 * session's own environment: it has to apply to the SPAWNED SERVER process
 * the CLI starts from this entry's own `command`/`args`, never to the CLI
 * itself, which needs no such thing and must not be handed an env var that
 * changes how ITS OWN process behaves if it too happens to be the Electron
 * binary (see `delegationServerCommand.ts` on why `command` is
 * `process.execPath`).
 */
function delegationEnv(context: DelegationInjectionContext): Record<string, string> {
  return {
    ELECTRON_RUN_AS_NODE: '1',
    [DELEGATION_ENDPOINT_ENV]: context.endpoint,
    [DELEGATION_TOKEN_ENV]: context.token,
    ...(context.waitMs === undefined ? {} : { [DELEGATION_WAIT_MS_ENV]: String(context.waitMs) })
  }
}

/** The exact shape the Agent SDK's `McpStdioServerConfig` takes (verified against `sdk.d.ts`). */
export interface ClaudeMcpStdioServerConfig {
  type: 'stdio'
  command: string
  args: string[]
  env: Record<string, string>
}

/**
 * The `mcpServers` map for a Claude session, held or detached alike — one
 * entry named `jev`, so both `sdkHeldSession.ts`'s own `Options.mcpServers`
 * and the `--mcp-config` file `claudeMcpConfigJson` below serializes agree
 * byte for byte on what a session actually sees.
 */
export function claudeHeldMcpServers(
  context: DelegationInjectionContext
): Record<string, ClaudeMcpStdioServerConfig> {
  return {
    [DELEGATION_SERVER_NAME]: {
      type: 'stdio',
      command: context.serverCommand,
      args: [...context.serverArgs],
      env: delegationEnv(context)
    }
  }
}

/**
 * The `--mcp-config` file body for a detached `claude -p` launch (#511 T4) —
 * the SAME server map `claudeHeldMcpServers` builds for a held session,
 * wrapped in the `{ mcpServers: … }` shape Claude Code's own `.mcp.json`
 * documents, so a file this app writes and a held session's own `Options`
 * describe identical behaviour.
 */
export function claudeMcpConfigJson(context: DelegationInjectionContext): string {
  return JSON.stringify({ mcpServers: claudeHeldMcpServers(context) })
}

/**
 * The extra argv a detached `claude -p` launch carries once the gate allows
 * it (#511 T4): `--mcp-config <file>` naming the config
 * `claudeMcpConfigJson` produced (written and removed by the launch's own
 * temp-file lifecycle — see `launchRunner.ts`), and `--allowedTools` naming
 * exactly the two delegation tools, so the turn can call them without the
 * interactive permission prompt a detached, unattended launch has nobody to
 * answer (see the module comment on `sdkHeldSession.ts` for the measured
 * consequence of an unanswered prompt: the request comes out as prose and
 * the turn ends).
 *
 * `--strict-mcp-config` is DELIBERATELY never added here — see
 * `launchRunner.ts`'s own comment on `launchClaudeSession` for the decision
 * and why: it would drop every MCP server the user's own config already
 * grants this session, which #511 has no business doing.
 */
export function claudeDetachedExtraArgs(configFilePath: string): string[] {
  return ['--mcp-config', configFilePath, '--allowedTools', ...DELEGATION_ALLOWED_TOOLS]
}

/** One `mcp.<name>` entry OpenCode's own docs shape (`type: 'local'`, an argv array, `environment`, `enabled`). */
interface OpenCodeLocalMcpEntry {
  type: 'local'
  command: string[]
  environment: Record<string, string>
  enabled: true
}

function openCodeDelegationEntry(context: DelegationInjectionContext): OpenCodeLocalMcpEntry {
  return {
    type: 'local',
    command: [context.serverCommand, ...context.serverArgs],
    environment: delegationEnv(context),
    enabled: true
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parses an existing `OPENCODE_CONFIG_CONTENT` value, or answers an empty
 * object for one this app cannot trust — absent, not JSON, or JSON that is
 * not an object. A launch's own env carrying a malformed value is not this
 * function's failure to report: OpenCode itself would refuse to parse it the
 * same way, and refusing to LAUNCH over a value this app never wrote would
 * be a worse outcome than starting fresh under the one key `mcp.jev` this
 * app actually owns.
 */
function parseExistingOpenCodeConfig(existing: string | undefined): Record<string, unknown> {
  if (existing === undefined || existing === '') return {}
  try {
    const parsed: unknown = JSON.parse(existing)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Merges the delegation server into an existing `OPENCODE_CONFIG_CONTENT`
 * env value (#511 T4) — never clobbers it: every other top-level key and
 * every other `mcp.<name>` entry survives untouched, and only `mcp.jev`
 * itself is replaced outright if one was already there (a stale prior
 * registration this app itself left behind, never a name a person would
 * pick for their own server).
 */
export function mergeOpenCodeConfigContent(
  existing: string | undefined,
  context: DelegationInjectionContext
): string {
  const parsed = parseExistingOpenCodeConfig(existing)
  const existingMcp = isRecord(parsed.mcp) ? parsed.mcp : {}
  return JSON.stringify({
    ...parsed,
    mcp: { ...existingMcp, [DELEGATION_SERVER_NAME]: openCodeDelegationEntry(context) }
  })
}

/**
 * Escapes a value for a TOML basic string (`"…"`): backslash first, then the
 * quote itself, so a Windows path's own backslashes survive round-tripping
 * through Codex's `-c key=value` TOML parser (#511 T4) — verified against
 * the feature document's own measurement (`codex -c 'mcp_servers.jevprobe
 * .command="node"' … mcp list` registered the server), extended here to the
 * general case a real install path needs: a backslash or a literal quote
 * inside `serverCommand`/`serverArgs` must not end the string early or
 * change what Codex's own TOML parser reads.
 */
function tomlString(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

function tomlStringArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(', ')}]`
}

function tomlInlineTable(entries: Record<string, string>): string {
  const pairs = Object.entries(entries).map(([key, value]) => `${key} = ${tomlString(value)}`)
  return `{ ${pairs.join(', ')} }`
}

/**
 * The `-c mcp_servers.jev.<key>=<TOML value>` triple Codex's own `--help`
 * documents (#511 T4) — built and table-tested even though Codex stays OUT
 * of `DELEGATION_CAPABLE_PROVIDERS` (`delegationGate.ts`) today: whether
 * `codex exec` actually exposes a `-c`-registered server's TOOLS to the
 * model, as opposed to merely listing it under `codex … mcp list`, is
 * unmeasured (feature document, 2026-09-23) — this app's own opt-in smoke
 * script (`scripts/smoke/delegation.mjs`) decides that. Enabling Codex once
 * it passes is then a one-line change to `DELEGATION_CAPABLE_PROVIDERS`,
 * never a second builder to write.
 *
 * Each `-c` and its value are separate argv elements, matching the measured
 * shape in the feature document (`-c 'mcp_servers.jevprobe.command="node"'`
 * is ONE shell-quoted argument, i.e. `-c` then the key=value pair as the
 * next argv element) — never `-c=value`, which Codex's own `--help` does not
 * document.
 */
export function codexDelegationConfigArgs(context: DelegationInjectionContext): string[] {
  return [
    '-c',
    `mcp_servers.${DELEGATION_SERVER_NAME}.command=${tomlString(context.serverCommand)}`,
    '-c',
    `mcp_servers.${DELEGATION_SERVER_NAME}.args=${tomlStringArray(context.serverArgs)}`,
    '-c',
    `mcp_servers.${DELEGATION_SERVER_NAME}.env=${tomlInlineTable(delegationEnv(context))}`
  ]
}
