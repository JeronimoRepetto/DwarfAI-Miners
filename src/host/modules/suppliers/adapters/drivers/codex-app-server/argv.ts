// The argv of the person's `codex` for an app-server session (15 §4.4 Launch): `app-server` over
// stdio and, only for a session launched with both delegation gates on (the launch then carries a
// `DelegationInjection`, ADR-013 item 4), the Jev MCP entry as `-c` config overrides: the relay
// command and args, its own env holding the credential FILE PATH (never the token: ADR-013 items
// 2, 8, which fixes `mcp/delegationInjection.ts:283-296` at `0bfd108`) and `ELECTRON_RUN_AS_NODE`
// (the relay form of 15 §4), and the pre-approval of exactly DwarfAI's two delegation tools in
// that entry — ADR-008 item 3's one named exception (C-24). Each `-c` value is TOML, as Codex parses
// it (`codex app-server --help`, 0.153.4). Every argv goes through `assertNoForbidden`.
//
// SP-12 (partial, 2026-10-17): Codex accepts the entry through `thread/start.config` without
// putting it in any descendant's argv, but the env half was not shown, so `mcpInjection` stays
// `ticket-file`: the path-only entry travels in argv as 15 §4.4 specifies, never through the
// protocol (spike SP-12 Decision).
import { assertNoForbidden, type DelegationGate } from '../shared/forbiddenFlags'
import { relayEntry, type RelayEntry } from '../shared/relayEntry'

/** The Jev entry's server name (ADR-013 items 1, 3). */
export const JEV_SERVER = 'jev'
/** DwarfAI's two delegation tools, the only ones the entry pre-approves (ADR-008 item 3). */
export const JEV_TOOLS: readonly string[] = Object.freeze(['delegate_subtask', 'subtask_result'])

const BOTH_GATES: DelegationGate = { subagentDelegationOn: true, launchedWithLetJevChoose: true }
const NO_GATE: DelegationGate = { subagentDelegationOn: false, launchedWithLetJevChoose: false }

/** What a gated delegation launch hands the argv builder (from `DriverLaunchRequest.delegation`). */
export interface JevRelay {
  readonly relay: { readonly program: string; readonly args: readonly string[] }
  readonly credentialFilePath: string
  readonly platform: NodeJS.Platform
}

/** A TOML basic string: JSON's escapes are TOML's (`\"`, `\\`, `\n`, `\uXXXX`). */
function tomlString(value: string): string {
  return JSON.stringify(value)
}

function tomlArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(',')}]`
}

/** A TOML inline table of string values; the relay env names are bare keys. */
function tomlTable(entries: Readonly<Record<string, string>>): string {
  return `{${Object.entries(entries)
    .map(([key, value]) => `${key}=${tomlString(value)}`)
    .join(',')}}`
}

function jevOverrides(entry: RelayEntry): string[] {
  const at = `mcp_servers.${JEV_SERVER}`
  const settings = [
    `${at}.command=${tomlString(entry.command)}`,
    `${at}.args=${tomlArray(entry.args)}`,
    `${at}.env=${tomlTable(entry.env)}`,
    ...JEV_TOOLS.map((tool) => `${at}.tools.${tool}.approval_mode="approve"`)
  ]
  return settings.flatMap((setting) => ['-c', setting])
}

/**
 * The argv (without the executable), checked against ADR-008 item 3. `jev` is null unless the
 * launch is gated in; a relay whose credential is not an absolute file path is refused
 * (`relayEntry`), so a value can never be passed in its place. `policyArgv` is a permission mode's
 * own flags (ADR-011 item 1). Throws `HostInvariantError` on a forbidden flag.
 */
export function buildArgv(jev: JevRelay | null, policyArgv: readonly string[] = []): string[] {
  const entry =
    jev === null
      ? null
      : relayEntry({
          command: jev.relay.program,
          args: jev.relay.args,
          credentialFilePath: jev.credentialFilePath,
          platform: jev.platform
        })
  const argv = ['app-server', ...(entry === null ? [] : jevOverrides(entry)), ...policyArgv]
  assertNoForbidden(argv, {}, { delegationGate: entry === null ? NO_GATE : BOTH_GATES })
  return argv
}
