// The relay's MCP server entry, the `15` §4 "Delegation relay form" (ADR-013 item 3, frozen):
// `{ command: <versioned-copy Host executable>, args: [<relay entry>], env: { ELECTRON_RUN_AS_NODE:
// '1', DWARFAI_MCP_CREDENTIAL_FILE: <path> } }`. That entry's own `env` is the only place the two
// variables appear, and it carries the credential FILE PATH, never the credential (ADR-013 item 2,
// C-15, C-23, INV-83); `childEnv` keeps both out of the provider child (15 §4 "Child environment").
//
// - `relayEntryArgs(hostEntryPath)`: the relay entry argument, the relay script `dwarfai-mcp.js`
//   that electron.vite.host.config.ts emits beside the Host entry `out/host/main.js` (in the app
//   directory, `app.asar` when packaged, which the executable reads under ELECTRON_RUN_AS_NODE as it
//   reads the Host entry). The composition root passes it to `DelegationLifecycle` as
//   `relayEntryArgs` (issueFor's `relay.args`; wiring: ISSUE-209).
// - `relayServerEntry`: the whole entry from `AppPaths.execPath` (ADR-002 D5), those arguments and
//   the credential file path. A path that is not absolute is refused: a value where the path belongs
//   is a defect, never a fallback.
//
// Candidate (21 §6): `src/main/mcp/delegationServerCommand.ts` replaced. It builds `{ command:
// execPath, args: [jevMcpServer.mjs] }` with no `env` (the legacy token travelled through the
// launch paths ADR-013 Context lists), so it cannot pass the C-23 env case of relayEntry.test.ts.
//
// Lead decision (2026-10-15, ISSUE-200): suppliers' `drivers/shared/relayEntry.ts` (PR #1299) builds
// the same form inside the drivers from the `DelegationInjection`; this one is delegation's, from
// the Host's own paths. Delegation may import suppliers' types only (AMENDMENT-14 A14-07).
import { dirname, join, posix, win32 } from 'node:path'
import { HostInvariantError } from '../../../../../kernel/domain/errors'
import type { AppPaths } from '../../../../../kernel/ports/appPaths'

/** The relay script's file name, beside `out/host/main.js` (the `dwarfai-mcp` relay of ADR-013). */
export const RELAY_ENTRY_FILE = 'dwarfai-mcp.js'

/** The relay entry's own variable (15 §4): the credential file's path, never the credential. */
export const CREDENTIAL_FILE_VARIABLE = 'DWARFAI_MCP_CREDENTIAL_FILE'

export interface RelayServerEntry {
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

/** The relay entry argument for the Host entry at `hostEntryPath` (`…/out/host/main.js`). */
export function relayEntryArgs(hostEntryPath: string): string[] {
  return [join(dirname(hostEntryPath), RELAY_ENTRY_FILE)]
}

export function relayServerEntry(input: {
  appPaths: Pick<AppPaths, 'execPath'>
  relayEntryArgs: readonly string[]
  credentialFilePath: string
  /** Whose path rules apply; default this process's OS. */
  platform?: NodeJS.Platform
}): RelayServerEntry {
  const paths = (input.platform ?? process.platform) === 'win32' ? win32 : posix
  if (input.credentialFilePath === '' || !paths.isAbsolute(input.credentialFilePath)) {
    throw new HostInvariantError('the relay entry carries the credential file path, never a value')
  }
  return {
    command: input.appPaths.execPath,
    args: [...input.relayEntryArgs],
    env: { ELECTRON_RUN_AS_NODE: '1', [CREDENTIAL_FILE_VARIABLE]: input.credentialFilePath }
  }
}
