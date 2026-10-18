// The OpenCode server calls that end a session, and the launch configuration a Host-launched
// server may carry (15 §4.6). Pure.
import type { DelegationInjection } from '../../../ports/providerDriver'
import { relayEntry } from '../shared/relayEntry'
import type { ServerRequest } from './permissionMapping'

/** The Jev entry's name in OpenCode's `mcp` configuration (ADR-013 item 3). */
const RELAY_NAME = 'dwarfai'

/**
 * SP-14 (`spike-results/SP-14.md`, OpenCode 1.18.32): `POST /session/{id}/abort?directory=<cwd>`,
 * no body, answered 200 `true`; it ends the session's turn and never signals the server.
 */
export function abortRequest(sessionId: string, directory: string): ServerRequest {
  return {
    method: 'POST',
    path: `/session/${encodeURIComponent(sessionId)}/abort?directory=${encodeURIComponent(directory)}`
  }
}

/**
 * The session list of a server: `GET /session`, answered `Session[]` (opencode.ai/docs/server;
 * S-031-3 measured its 401 / 200 against a password-protected server).
 */
export function listSessionsRequest(): ServerRequest {
  return { method: 'GET', path: '/session' }
}

/** How a session of the server driver ends (15 §4.6 End / kill; ADR-014). */
export type ClosePlan =
  | { readonly kind: 'abort'; readonly request: ServerRequest }
  | { readonly kind: 'tree-kill-own-server' }

/**
 * The abort endpoint when SP-14 recorded one; otherwise the only way left is the identity-checked
 * tree kill of the Host's own server (ADR-014), never of a person-run one (FM-064, FM-080).
 */
export function closePlan(sessionId: string, directory: string, abortRecorded: boolean): ClosePlan {
  return abortRecorded
    ? { kind: 'abort', request: abortRequest(sessionId, directory) }
    : { kind: 'tree-kill-own-server' }
}

/**
 * `OPENCODE_CONFIG_CONTENT` for a Host-launched server (15 §4.6 Launch, replacing
 * `launchRunner.ts:1030-1050`, #511 L3): the relay entry and nothing else, its environment the
 * relay's own two variables, the credential as a file **path** (`relayEntry` refuses anything
 * else; ADR-013 item 2, ADR-017 item 3). No password, token or permission setting is ever in it.
 */
export function configContent(delegation: DelegationInjection, platform: NodeJS.Platform): string {
  const entry = relayEntry({
    command: delegation.relay?.program ?? '',
    args: delegation.relay?.args ?? [],
    credentialFilePath: delegation.credentialFilePath ?? '',
    platform
  })
  return JSON.stringify({
    mcp: {
      [RELAY_NAME]: {
        type: 'local',
        command: [entry.command, ...entry.args],
        environment: { ...entry.env }
      }
    }
  })
}
