// The plugin DwarfAI writes into OpenCode's plugin folder (16 §7.1; ADR-016 items 1, 6.2; ADR-011
// item 7): a zero-import artifact (TM §2 inv. 8) that OpenCode loads and runs itself, outside every
// DwarfAI runtime, so it uses only what OpenCode's own runtime gives a plugin (`fetch`,
// `AbortSignal`, `Set`, `JSON`, `String`). Pure: the install id, the ingress port and the token are
// parameters.
//
// Evaluated candidate: the legacy `src/main/opencodePermissions/opencodePermissionPlugin.ts` (found
// tree) — adapted. Kept: the entry shape OpenCode loads (an async function returning `{ event }`),
// reporting only `permission.asked` and `permission.replied`, the raw `{ event, serverUrl }` body
// (shaping it into an ask is the ingress's job, ISSUE-229), the `x-dwarfai-token` header (ADR-016
// item 2), the 2-second timeout, and the rule that a report that cannot be sent never throws into
// OpenCode. Changed: the first line is DwarfAI's exact ownership header with this install's id
// (ADR-016 item 6.2), the URL is the Host ingress's `/opencode/*` route (ADR-016 item 1) instead of
// the legacy listener's `/dwarfai-miners-hook/opencode`, and the token is the plugin channel's own
// `openCodePluginToken`, which the legacy file shared with the Claude hooks (ADR-016 item 1, C2).
// The legacy source file was copied to disk as it is, with placeholders replaced; here the bytes
// are rendered from one template so the ownership header, the URL line and the token line have
// exact shapes the writer can probe.
import { HostInvariantError } from '../../../../../kernel/domain/errors'

/** The first line of every file DwarfAI writes there, before the install id (16 §7.1). */
export const OWNED_HEADER_PREFIX = '// dwarfai-managed '

/**
 * The ingress path the plugin reports to. Package gap: ADR-016 item 1 gives the route as
 * `/opencode/*` and ISSUE-229 serves it; this is one path under it.
 */
export const OPENCODE_INGRESS_PATH = '/opencode/event'

/** Kept from the legacy installer: lower-case hex only, so no value can close the quoted literal. */
const TOKEN_PATTERN = /^[0-9a-f]{16,}$/
/** `app_meta.install_id`: a UUID (10 §app_meta), lower case, so the header is one exact line. */
const INSTALL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export interface PluginArtifactInput {
  /** This installation's id (`app_meta.install_id`). */
  installId: string
  /** The persisted ingress port (ADR-016 item 3). */
  port: number
  /** `openCodePluginToken`, plaintext only here and in the written file (ADR-016 item 1). */
  token: string
}

/** The exact ownership header of this installation's file (ADR-016 item 6.2). */
export function ownedHeader(installId: string): string {
  if (!INSTALL_ID_PATTERN.test(installId)) {
    throw new HostInvariantError('the OpenCode plugin header needs a lower-case UUID install id')
  }
  return `${OWNED_HEADER_PREFIX}${installId}`
}

/** The URL line of a rendered plugin, and the one the writer reads the port back from. */
const urlLine = (port: number): string =>
  `const PUSH_URL = 'http://127.0.0.1:${port}${OPENCODE_INGRESS_PATH}'`
const URL_LINE = /^const PUSH_URL = 'http:\/\/127\.0\.0\.1:(\d{1,5})\/opencode\/event'$/m
/** The token line of a rendered plugin, and the one the writer reads the token back from. */
const tokenLine = (token: string): string => `const PUSH_TOKEN = '${token}'`
const TOKEN_LINE = /^const PUSH_TOKEN = '([0-9a-f]{16,})'$/m

/** The port a rendered plugin reports to; `null` when its URL line is not there. */
export function portOfArtifact(text: string): number | null {
  const port = URL_LINE.exec(text)?.[1]
  return port === undefined ? null : Number(port)
}

/** The token a rendered plugin carries; `null` when its token line is not there. */
export function tokenOfArtifact(text: string): string | null {
  return TOKEN_LINE.exec(text)?.[1] ?? null
}

/**
 * The plugin file's text. Every value is checked before anything is rendered, and a refusal never
 * echoes the value it refused (NFR-SEC-12).
 */
export function renderPluginArtifact(input: PluginArtifactInput): string {
  const header = ownedHeader(input.installId)
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
    throw new HostInvariantError('the OpenCode plugin needs an ingress port between 1 and 65535')
  }
  if (!TOKEN_PATTERN.test(input.token)) {
    throw new HostInvariantError('the OpenCode plugin token must be lower-case hex')
  }
  return [
    header,
    '// Written by DwarfAI-Miners, which removes it when its OpenCode permission requests integration is',
    "// turned off. It reports OpenCode's permission requests to DwarfAI on this computer; the token below",
    '// only lets OpenCode report them. It loads nothing: OpenCode runs it as it is.',
    urlLine(input.port),
    tokenLine(input.token),
    "const PUSHED_EVENT_TYPES = new Set(['permission.asked', 'permission.replied'])",
    '',
    'function pushEvent(serverUrl, event) {',
    "  if (event === null || typeof event !== 'object' || !PUSHED_EVENT_TYPES.has(event.type)) return",
    '  try {',
    '    fetch(PUSH_URL, {',
    "      method: 'POST',",
    "      headers: { 'content-type': 'application/json', 'x-dwarfai-token': PUSH_TOKEN },",
    '      body: JSON.stringify({ event, serverUrl: serverUrl === undefined ? null : String(serverUrl) }),',
    '      signal: AbortSignal.timeout(2000)',
    '    }).catch(() => undefined)',
    '  } catch {',
    '    // Never thrown into OpenCode: a report that cannot be sent is a report DwarfAI did not get.',
    '  }',
    '}',
    '',
    'export const DwarfAiOpenCodePermissionPlugin = async (ctx) => ({',
    '  event: async ({ event }) => {',
    '    pushEvent(ctx === undefined ? undefined : ctx.serverUrl, event)',
    '  }',
    '})',
    ''
  ].join('\n')
}
