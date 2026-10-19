// `/hooks/claude/*` on the loopback ingress (ADR-016 items 1, 2 and 4; ADR-012 item 6; 16 §4.12
// `setClaudeHooks`, `ChannelTokenStore`; 16 §4.3 `ObservationControl.nudge`; 08 §4).
//
// - Admission: `401` unless the `claude-hooks` integration is `on-verified` (ADR-012 item 6) and the
//   `x-dwarfai-token` is the active Claude hooks token, compared as a SHA-256 hash in constant time
//   by the transport's ChannelTokenCheck (ISSUE-219), which logs its own refusals; a refusal by the
//   integration gate is logged here, so each `401` is logged exactly once.
// - The body: the strict schema of `claudeHookPayload.ts`.
// - An accepted event is evidence, never a command (ADR-016 item 4): it nudges the observer and
//   hands the evidence to the observed-Claude channel (consumed by ISSUE-134). The route reaches no
//   other port, so it can never answer an ask, launch, end a session or change a setting. Both run
//   only after the answer was sent (httpIngress.ts), and a failure in either is swallowed: a hook
//   must never see an error it could act on, and a nudge is only a hint (FM-038).
import type { DiagnosticsLog } from '../../kernel/ports/diagnosticsLog'
import type { ObservationControl } from '../../modules/observation'
import type { PreferencesQueries } from '../../modules/preferences'
import type { ChannelTokenCheck } from '../auth/channelTokenCheck'
import { parseClaudeHookPayload, type ClaudeHookEvidence } from './claudeHookPayload'
import type { IngressRoute } from './httpIngress'

/** The observed-Claude hand-off (ISSUE-134 consumes it): evidence in, nothing back. */
export interface ClaudeHookEvidenceSink {
  accept(evidence: ClaudeHookEvidence): void
}

export interface ClaudeHooksRouteDeps {
  tokens: Pick<ChannelTokenCheck, 'authenticate'>
  preferences: Pick<PreferencesQueries, 'integrationState'>
  observation: Pick<ObservationControl, 'nudge'>
  evidence: ClaudeHookEvidenceSink
  log: DiagnosticsLog
}

/** The provider the Claude hook events report on (catalog id). */
const CLAUDE_PROVIDER_ID = 'claude'
const CHANNEL = 'claude-hooks'

export function createClaudeHooksRoute(deps: ClaudeHooksRouteDeps): IngressRoute {
  const deliver = (evidence: ClaudeHookEvidence): void => {
    try {
      deps.observation.nudge({
        providerId: CLAUDE_PROVIDER_ID,
        ...(evidence.sessionId === undefined ? {} : { sessionId: evidence.sessionId }),
        ...(evidence.transcriptPath === undefined ? {} : { path: evidence.transcriptPath })
      })
    } catch {
      // A nudge is only a hint: the poll loop still runs (FM-038).
    }
    try {
      deps.evidence.accept(Object.freeze({ ...evidence }))
    } catch {
      // The hand-off's own failure stays its own; the hook already has its answer.
    }
  }

  return {
    channel: CHANNEL,
    prefix: '/hooks/claude/',
    admits(token: unknown): boolean {
      if (deps.preferences.integrationState(CHANNEL) !== 'on-verified') {
        deps.log.record({
          level: 'warn',
          event: 'ingress.rejected',
          subsystem: CHANNEL,
          causeClass: '401'
        })
        return false
      }
      return deps.tokens.authenticate(CHANNEL, token)
    },
    accept(body: string): (() => void) | null {
      const evidence = parseClaudeHookPayload(body)
      return evidence === null ? null : () => deliver(evidence)
    }
  }
}
