// `AskAnswerChannel` for `http` (16 §4.7 row `AskAnswerChannel` (`http`): `OpenCodePluginAskChannel`;
// 15 §2.7 row "OpenCode HTTP"; ADR-011 item 7; ADR-017 item 3; 13 FM-074, FM-116): the person's
// Allow or Deny on a card opened from a report of DwarfAI's OpenCode plugin, posted to the OpenCode
// server that asked.
//
// - The request is the one S-011-1 recorded at OpenCode 1.18.32 (`fixtures/opencode/http-server/
//   1.18.32/s0111-person-run-deny*`: 200 `true`): `POST <server>/permission/<id>/reply?directory=
//   <the session's folder>` with `{ reply }`; Allow is `once`, Deny is `reject`, and `always` is
//   never sent (ADR-008 item 3; ADR-010 item 3). The plugin's `permission.ask` hook is never relied
//   on: OpenCode 1.18.32 never called it (S-011-1); the plugin reports the `permission.asked` event.
// - Where it goes: the server origin and the session's folder the OpenCode plugin asks recorded for
//   this dwarf's request when it opened the ask (`OpenCodeAnswerTargets`, ./openCodePluginAsks.ts).
//   A request with no recorded address cannot be proven pending, so it is `not-open` and nothing is
//   sent. The origin is checked again here: anything but plain `http` on this machine's loopback is
//   refused `channel-unavailable` before the password is even read (ADR-017 item 3).
// - The password: read through the kernel `SecretReader` for each answer, outside any transaction,
//   and placed only in the `Authorization` header, as HTTP Basic with OpenCode's default user
//   `opencode`; never in the URL, the body, a log record or any other header (ADR-017 item 3,
//   18 C-22). Not configured: no header (OpenCode's default server takes no auth). A read that
//   times out (`'timeout'`, 16 §2.6) or fails is `refused: 'channel-unavailable'` with nothing sent
//   (FM-116). Redirects are refused, so the header never follows the request elsewhere.
// - The reply: 2xx with `true` is `accepted`; 2xx with anything else or 404 is `not-open` (the
//   request is no longer pending); 400, 401 and 403 are `refused: 'channel-rejected'` (the server
//   refused the answer or the stored password, FM-074); anything else, a network failure or no
//   answer within `OPENCODE_ANSWER_TIMEOUT_MS` is `refused: 'channel-unavailable'`. Each failure is
//   one `asking.opencode-answer` record with its cause class only (19 §7).
// - Questions are never answered here: the plugin reports permissions only, so no question ever
//   opens on this channel; `answerQuestion` and `declineQuestion` answer `not-open`.
//
// Package gaps (resolved here, recorded in the PR): the Basic scheme and the `opencode` user are
// OpenCode's documented server auth (the legacy adapter's reading of the binary), not yet measured
// against a password-protected server (UNVERIFIED, like the legacy one); the answer timeout is 10 s,
// inside the broker's 30 s hand-over bound (ADR-010 item 8).
//
// Evaluated candidate: the legacy `src/main/opencodePermissions/answerOpenCodePermission.ts` (found
// tree) — replaced. Kept: the injected fetch, loopback-only credentials, the Basic `opencode` user and
// a bounded wait. Changed: the route and body S-011-1 recorded (`/permission/<id>/reply`,
// `{ reply }`, with the session's folder) instead of `session/<id>/permissions/<id>` with
// `{ response }`; `always` is not sendable; the password comes from the `SecretReader` instead of the
// legacy encrypted store; an address off this machine gets nothing at all instead of the request
// without the credential; and the outcome is ADR-010's `AnswerOutcome`.
import type { AnswerOutcome, QuestionAnswers } from '../../../../kernel/domain/sharedContracts'
import type { DwarfId } from '../../../../kernel/domain/values'
import type { DiagnosticsLog } from '../../../../kernel/ports/diagnosticsLog'
import type { SecretReader } from '../../../../kernel/ports/secretReader'
import type { ProviderCapabilities } from '../../../suppliers'
import type { AskAnswerChannel } from '../../ports/askAnswerChannel'
import type { AskChannelRef } from '../../ports/askRepository'

/** This channel's capability record (ADR-009 D2 fields). */
export const OPENCODE_PLUGIN_CHANNEL_CAPABILITIES = {
  /** A late reply to a request OpenCode no longer holds is refused by the server, nothing else. */
  staleAnswerSafe: true,
  /** SP-09 has no passed record: a reply made elsewhere is never claimed (21 §2 4a). */
  answeredElsewhere: false
} as const satisfies Pick<ProviderCapabilities, 'staleAnswerSafe' | 'answeredElsewhere'>

/** How long an answer waits for the OpenCode server (inside ADR-010 item 8's 30 s). */
export const OPENCODE_ANSWER_TIMEOUT_MS = 10_000

/** OpenCode's default server user; DwarfAI stores only the password (ADR-017 item 1). */
const OPENCODE_SERVER_USER = 'opencode'
/** The hosts an answer may be posted to: this machine's loopback only. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]'])
/** The provider this channel answers for (catalog id), for its diagnostics. */
const OPENCODE_PROVIDER_ID = 'opencode'

/** Where a request's answer goes: the server that asked and the session's folder. */
export interface OpenCodeAnswerTarget {
  /** `http://<loopback>:<port>`. */
  readonly serverOrigin: string
  /** The session's folder, OpenCode's `directory` (the instance that holds the request). */
  readonly directory: string
}

/** The address recorded for a dwarf's request when its ask was opened. */
export interface OpenCodeAnswerTargets {
  targetOf(dwarfId: DwarfId, providerRequestId: string): OpenCodeAnswerTarget | null
}

/** The one HTTP call this channel makes; `globalThis.fetch` fits it. */
export type OpenCodeHttpPost = (
  url: string,
  init: {
    method: 'POST'
    headers: Record<string, string>
    body: string
    redirect: 'error'
    signal: AbortSignal
  }
) => Promise<{ status: number; text(): Promise<string> }>

export interface OpenCodePluginAskChannelDeps {
  targets: OpenCodeAnswerTargets
  secrets: Pick<SecretReader, 'read'>
  post: OpenCodeHttpPost
  log: DiagnosticsLog
  /** `OPENCODE_ANSWER_TIMEOUT_MS` by default. */
  timeoutMs?: number
}

const NOT_OPEN: AnswerOutcome = { kind: 'not-open' }
const UNAVAILABLE: AnswerOutcome = { kind: 'refused', reason: 'channel-unavailable' }
const REJECTED: AnswerOutcome = { kind: 'refused', reason: 'channel-rejected' }

export class OpenCodePluginAskChannel implements AskAnswerChannel {
  readonly capabilities = OPENCODE_PLUGIN_CHANNEL_CAPABILITIES

  constructor(private readonly deps: OpenCodePluginAskChannelDeps) {}

  async answerPermission(
    ref: AskChannelRef,
    providerRequestId: string,
    decision: 'allow' | 'deny'
  ): Promise<AnswerOutcome> {
    const target = this.deps.targets.targetOf(ref.dwarfId, providerRequestId)
    if (target === null) return NOT_OPEN
    const origin = loopbackOrigin(target.serverOrigin)
    if (origin === null) return this.fail(ref, 'off-loopback', UNAVAILABLE)

    let password: string | null | 'timeout'
    try {
      password = await this.deps.secrets.read('opencode-password')
    } catch {
      return this.fail(ref, 'secret-failed', UNAVAILABLE)
    }
    if (password === 'timeout') return this.fail(ref, 'secret-timeout', UNAVAILABLE)

    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (password !== null && password !== '') {
      headers['authorization'] =
        `Basic ${Buffer.from(`${OPENCODE_SERVER_USER}:${password}`, 'utf8').toString('base64')}`
    }
    const url =
      `${origin}/permission/${encodeURIComponent(providerRequestId)}/reply` +
      `?directory=${encodeURIComponent(target.directory)}`
    try {
      const response = await this.deps.post(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ reply: decision === 'allow' ? 'once' : 'reject' }),
        redirect: 'error',
        signal: AbortSignal.timeout(this.deps.timeoutMs ?? OPENCODE_ANSWER_TIMEOUT_MS)
      })
      return await this.outcomeOf(ref, response)
    } catch {
      return this.fail(ref, 'unreachable', UNAVAILABLE)
    }
  }

  answerQuestion(
    _ref: AskChannelRef,
    _providerRequestId: string,
    _answers: QuestionAnswers
  ): Promise<AnswerOutcome> {
    return Promise.resolve(NOT_OPEN)
  }

  declineQuestion(_ref: AskChannelRef, _providerRequestId: string): Promise<AnswerOutcome> {
    return Promise.resolve(NOT_OPEN)
  }

  private async outcomeOf(
    ref: AskChannelRef,
    response: { status: number; text(): Promise<string> }
  ): Promise<AnswerOutcome> {
    const { status } = response
    if (status >= 200 && status < 300) {
      return (await response.text()).trim() === 'true' ? { kind: 'accepted' } : NOT_OPEN
    }
    if (status === 404) return NOT_OPEN
    if (status === 400 || status === 401 || status === 403) {
      return this.fail(ref, `http-${status}`, REJECTED)
    }
    return this.fail(ref, `http-${status}`, UNAVAILABLE)
  }

  /** One record with the cause class only (19 §7): never the URL, the folder or a header. */
  private fail(ref: AskChannelRef, causeClass: string, outcome: AnswerOutcome): AnswerOutcome {
    this.deps.log.record({
      level: 'warn',
      event: 'asking.opencode-answer',
      subsystem: 'asking',
      outcome: 'failed',
      causeClass,
      provider: OPENCODE_PROVIDER_ID,
      dwarfId: ref.dwarfId
    })
    return outcome
  }
}

/** `http://<host>:<port>` of a plain-`http` loopback origin with no credentials, or `null`. */
function loopbackOrigin(value: string): string | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' || url.username !== '' || url.password !== '') return null
  return LOOPBACK_HOSTS.has(url.hostname) ? url.origin : null
}
