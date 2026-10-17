// `/opencode/*` on the loopback ingress (ADR-016 items 1, 2 and 4; ADR-011 item 7; ADR-017 item 3;
// 13 FM-038): the route DwarfAI's OpenCode plugin reports to (ISSUE-227 writes the plugin, whose
// `event` hook posts every `permission.asked` and `permission.replied` as `{ event, serverUrl }` to
// `OPENCODE_PLUGIN_PATH`, with the `openCodePluginToken` in `x-dwarfai-token`).
//
// - Admission: `401` unless the `x-dwarfai-token` is the active token of the `opencode-plugin`
//   channel, checked by the transport's ChannelTokenCheck (ISSUE-219), which logs its own refusals.
//   The channel is fixed here: a Claude hooks token, or any other channel's, never authenticates
//   on this route (ADR-016 items 1–2). The integration gate is not read here: with the integration
//   off the token is revoked (ADR-016 item 1), and while it is on but not verified the asking open
//   route applies ADR-011 items 1–4 (wiring/routes/asking.ts), so a launched session's request is
//   still denied through the protocol.
// - The hardening (`127.0.0.1`, no `Origin`, the `Host` check, the 256 KiB cap, the rate limit) is
//   the ingress's, shared with the Claude routes (httpIngress.ts).
// - The body: `{ event, serverUrl }` and nothing else. The event is OpenCode's `permission.asked`
//   (S-011-1, OpenCode 1.18.32: `id`, `sessionID`, `permission`, `patterns`, …) or
//   `permission.replied` (`sessionID`, `requestID`, `reply`); any other type, a missing id, or a
//   field of the wrong type is `400`. Unknown fields inside the event are ignored and never kept:
//   the evidence carries the ids, the permission kind, its patterns and the server's origin only
//   (never the diff or file content of `metadata`, ADR-007 item 4).
// - `serverUrl` is the address the person's answer will be posted to with the OpenCode password
//   (ADR-017 item 3), and the report is only evidence (ADR-016 item 4): an address that is not
//   plain `http` on this machine's loopback (`127.0.0.1`, `localhost`, `[::1]`), or that carries
//   credentials, is `400`. The answer channel checks it again before it sends anything.
// - An accepted report is evidence, never a command (ADR-016 item 4): it nudges the observer for
//   the session and hands the evidence to the OpenCode plugin asks (wiring/routes/asking.ts), which
//   may open an ask; the route reaches no other port, so it can never answer an ask, launch, end a
//   session or change a setting. Both run after the answer was sent (httpIngress.ts) and a failure
//   in either is swallowed (FM-038).
//
// Evaluated candidate: the legacy relay (`src/main/opencodePermissions/openCodePluginChannel.ts`,
// `permissionPushPayload.ts`, found tree) — replaced. The legacy route sat on the old listener with
// the token it shared with the Claude hooks (ADR-016 item 1 gives each channel its own), and its
// parser kept fields this route never needs; the shape it read (`{ event, serverUrl }` of the
// plugin's `event` hook) is kept, as ISSUE-227's plugin still sends it.
import type { ProviderId } from '../../kernel/domain/values'
import type { DiagnosticsLog } from '../../kernel/ports/diagnosticsLog'
import type { ObservationControl } from '../../modules/observation'
import type { ChannelTokenCheck } from '../auth/channelTokenCheck'
import type { IngressRoute } from './httpIngress'

/** The path the written plugin posts to (ISSUE-227 `OPENCODE_INGRESS_PATH`). */
export const OPENCODE_PLUGIN_PATH = '/opencode/event'

/** What an accepted plugin report hands on: evidence only. */
export type OpenCodePluginEvidence =
  | {
      readonly kind: 'permission.asked'
      readonly sessionId: string
      /** OpenCode's permission id: the ask's `providerRequestId`. */
      readonly requestId: string
      /** OpenCode's permission kind (`edit`, `bash`, …). */
      readonly permission: string
      readonly patterns: readonly string[]
      /** `http://<loopback>:<port>` of the server that asked. */
      readonly serverOrigin: string
    }
  | { readonly kind: 'permission.replied'; readonly sessionId: string; readonly requestId: string }

/** The OpenCode plugin asks' hand-off (wiring/routes/asking.ts): evidence in, nothing back. */
export interface OpenCodePluginEvidenceSink {
  accept(evidence: OpenCodePluginEvidence): void
}

export interface OpenCodePluginRouteDeps {
  tokens: Pick<ChannelTokenCheck, 'authenticate'>
  observation: Pick<ObservationControl, 'nudge'>
  evidence: OpenCodePluginEvidenceSink
  log: DiagnosticsLog
}

/** The provider the plugin reports on (catalog id), for the observer's nudge. */
const OPENCODE_PROVIDER_ID = 'opencode' as ProviderId
const CHANNEL = 'opencode-plugin'

/** The hosts an OpenCode server address may name: this machine's loopback only. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]'])
/** An id longer than this is not one OpenCode mints. */
const MAX_ID_LENGTH = 256
/** The patterns a card can show; the rest are dropped. */
const MAX_PATTERNS = 32
const MAX_PATTERN_LENGTH = 4_096

export function createOpenCodePluginRoute(deps: OpenCodePluginRouteDeps): IngressRoute {
  const deliver = (evidence: OpenCodePluginEvidence): void => {
    try {
      deps.observation.nudge({ providerId: OPENCODE_PROVIDER_ID, sessionId: evidence.sessionId })
    } catch {
      // A nudge is only a hint: the poll loop still runs (FM-038).
    }
    try {
      deps.evidence.accept(evidence)
    } catch {
      // The hand-off's own failure stays its own; the plugin already has its answer.
    }
  }

  return {
    channel: CHANNEL,
    prefix: '/opencode/',
    admits: (token: unknown): boolean => deps.tokens.authenticate(CHANNEL, token),
    accept(body: string): (() => void) | null {
      const evidence = parseOpenCodePluginReport(body)
      return evidence === null ? null : () => deliver(evidence)
    }
  }
}

type Fields = Readonly<Record<string, unknown>>

const fieldsOf = (value: unknown): Fields | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Fields) : null

const idOf = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH ? value : null

/** The `{ event, serverUrl }` body of a plugin report as evidence, or `null` for a `400`. */
export function parseOpenCodePluginReport(body: string): OpenCodePluginEvidence | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  const report = fieldsOf(parsed)
  if (
    report === null ||
    Object.keys(report).some((key) => key !== 'event' && key !== 'serverUrl')
  ) {
    return null
  }
  const event = fieldsOf(report['event'])
  const props = fieldsOf(event?.['properties'])
  if (event === null || props === null) return null
  const sessionId = idOf(props['sessionID'])
  if (sessionId === null) return null

  if (event['type'] === 'permission.replied') {
    const requestId = idOf(props['requestID'])
    return requestId === null ? null : { kind: 'permission.replied', sessionId, requestId }
  }
  if (event['type'] !== 'permission.asked') return null
  const requestId = idOf(props['id'])
  const permission = idOf(props['permission'])
  const serverOrigin = loopbackOrigin(report['serverUrl'])
  if (requestId === null || permission === null || serverOrigin === null) return null
  return {
    kind: 'permission.asked',
    sessionId,
    requestId,
    permission,
    patterns: patternsOf(props['patterns']),
    serverOrigin
  }
}

/**
 * `http://<host>:<port>` of a plain-`http` loopback address with no credentials, or `null`
 * (ADR-017 item 3: the password goes only to the local OpenCode server).
 */
export function loopbackOrigin(value: unknown): string | null {
  if (typeof value !== 'string') return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' || url.username !== '' || url.password !== '') return null
  return LOOPBACK_HOSTS.has(url.hostname) ? url.origin : null
}

function patternsOf(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string' && item.length <= MAX_PATTERN_LENGTH)
    .slice(0, MAX_PATTERNS)
}
