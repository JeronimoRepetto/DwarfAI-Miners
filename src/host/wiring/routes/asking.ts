// The OpenCode plugin's asking open route (ISSUE-229; 08 §4: plugin ingress → asking `open` after
// resolving the session to its dwarf; ADR-011 item 7; ADR-016 items 1, 4; ADR-017 item 3): the
// `/opencode/*` ingress route, the OpenCode plugin asks it feeds and the `http` answer channel,
// composed for the Host's asking wiring (routes/askingRoutes.ts).
//
// - The route (transport/ingress/openCodeRoutes.ts) admits only the active `opencode-plugin` token
//   through its own ChannelTokenCheck, and hands each accepted report here as evidence.
// - A `permission.asked` report is resolved through observation's `ProviderIdentity → DwarfId`
//   index (16 §4.3 `ObservedSessionStore.byIdentity`) with OpenCode's catalog id and the report's
//   session id; the observed session's `cwd` is the folder OpenCode's `directory` names. The
//   OpenCode plugin asks (asking/adapters/openCodePlugin) open it on the broker's `http` channel and
//   keep the address its answer goes to. A `permission.replied` report opens and resolves nothing
//   (SP-09: `answeredElsewhere: false`).
// - The gate (ADR-011 item 7): an observed OpenCode session's permission is answerable from a card
//   — `permission: 'interactive'`, `observedPermission: 'detected'` — only while
//   `opencode-permissions` is `on-verified` (S-011-1: "written and read back"); in every other
//   state the observing adapter's declaration stands (no answer path: the broker opens no ask,
//   ADR-011 item 4). `observedCapabilities` is that rule, read by the asking wiring's
//   `SessionCapabilities` binding. Questions are not raised: the plugin reports permissions only. A
//   launched session's capabilities are suppliers' (the catalog's `answerChannelGate` applied
//   there, ADR-009 D1), so while the gate is closed its request is `auto-denied` with one chat line
//   and answered Deny on this channel (ADR-011 item 3).
// - Legacy-launched OpenCode sessions (still `legacy` until 4b) are sessions the Host observes, so
//   their plugin asks reach this broker and are answered by the Host (21 §2 4a).
//
// The provider is compared through the injected catalog id, never a literal (R12).
import type { ProviderId } from '../../kernel/domain/values'
import type { DiagnosticsLog } from '../../kernel/ports/diagnosticsLog'
import type { Scheduler } from '../../kernel/ports/scheduler'
import type { SecretReader } from '../../kernel/ports/secretReader'
import type { AskBroker, AskCapabilities } from '../../modules/asking'
import {
  OpenCodePluginAskChannel,
  type OpenCodeHttpPost
} from '../../modules/asking/adapters/openCodePlugin/OpenCodePluginAskChannel'
import { OpenCodePluginAsks } from '../../modules/asking/adapters/openCodePlugin/openCodePluginAsks'
import type { ObservationControl, ObservedSessionStore } from '../../modules/observation'
import type { ChannelTokenStore, PreferencesQueries } from '../../modules/preferences'
import { ChannelTokenCheck } from '../../transport/auth/channelTokenCheck'
import type { IngressRoute } from '../../transport/ingress/httpIngress'
import {
  createOpenCodePluginRoute,
  type OpenCodePluginEvidenceSink
} from '../../transport/ingress/openCodeRoutes'

export interface OpenCodePluginAskingDeps {
  /** OpenCode's catalog id: the identity the plugin's session ids are looked up under. */
  providerId: ProviderId
  /** Observation's `ProviderIdentity → DwarfId` index (16 §4.3). */
  sessions: Pick<ObservedSessionStore, 'byIdentity'>
  /** The one broker's `open` (16 §4.7). */
  asks: Pick<AskBroker, 'open'>
  /** The gate and the plugin channel's token (ADR-011 item 7; ADR-016 item 1). */
  preferences: {
    queries: Pick<PreferencesQueries, 'integrationState'>
    channelTokens: Pick<ChannelTokenStore, 'active'>
  }
  observation: Pick<ObservationControl, 'nudge'>
  /** The kernel `SecretReader`: the OpenCode password, for the answer only (ADR-017 item 3). */
  secrets: Pick<SecretReader, 'read'>
  /** The one HTTP call of the answer channel (`globalThis.fetch` in the Host). */
  post: OpenCodeHttpPost
  scheduler: Scheduler
  /** The one redaction rule (`contracts/logging` `redactSecrets`), bound here (05 R9). */
  redact(text: string): string
  log: DiagnosticsLog
}

export interface OpenCodePluginAsking {
  /** `/opencode/*`, for the ingress listener (wiring/hookIngress.ts). */
  route: IngressRoute
  /** The broker's `http` answer channel. */
  channel: OpenCodePluginAskChannel
  /** The route's hand-off (also for tests). */
  evidence: OpenCodePluginEvidenceSink
  /** ADR-011 item 7's gate on an observed session's declared capabilities. */
  observedCapabilities(providerId: ProviderId, declared: AskCapabilities): AskCapabilities
}

/** The gating integration (ADR-011 item 7; catalog `answerChannelGate` of OpenCode). */
const GATE = 'opencode-permissions'

export function wireOpenCodePluginAsking(deps: OpenCodePluginAskingDeps): OpenCodePluginAsking {
  const asks = new OpenCodePluginAsks({
    sessionOf: (providerSessionId) => {
      const session = deps.sessions.byIdentity({ providerId: deps.providerId, providerSessionId })
      return session === null ? null : { dwarfId: session.dwarfId, directory: session.cwd }
    },
    asks: deps.asks,
    redact: deps.redact,
    scheduler: deps.scheduler,
    log: deps.log
  })
  const channel = new OpenCodePluginAskChannel({
    targets: asks,
    secrets: deps.secrets,
    post: deps.post,
    log: deps.log
  })
  const evidence: OpenCodePluginEvidenceSink = {
    accept(report): void {
      if (report.kind !== 'permission.asked') return
      asks.report({
        sessionId: report.sessionId,
        requestId: report.requestId,
        permission: report.permission,
        patterns: report.patterns,
        serverOrigin: report.serverOrigin
      })
    }
  }
  const route = createOpenCodePluginRoute({
    tokens: new ChannelTokenCheck({ tokens: deps.preferences.channelTokens, log: deps.log }),
    observation: deps.observation,
    evidence,
    log: deps.log
  })
  return {
    route,
    channel,
    evidence,
    observedCapabilities(providerId, declared) {
      if (providerId !== deps.providerId) return declared
      if (deps.preferences.queries.integrationState(GATE) !== 'on-verified') return declared
      return { ...declared, permission: 'interactive', observedPermission: 'detected' }
    }
  }
}
