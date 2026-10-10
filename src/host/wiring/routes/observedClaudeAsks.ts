// The observed-Claude hook route (08 §4: hook ingress → asking `open` after resolving the session to
// its dwarf; ADR-012 items 3, 6; ADR-010 item 10 "Observed Claude (hook ingress): hook event + prompt
// registry"). It is the `ClaudeHookEvidenceSink` the `/hooks/claude/*` route hands every accepted
// event to (transport/ingress/claudeHooksRoute.ts, ISSUE-133), so it runs only while the
// `claude-hooks` integration is `on-verified` (ADR-012 item 6: with it off, the ingress answers 401
// and no evidence reaches here).
//
// - The session id is resolved to its dwarf through observation's `ProviderIdentity → DwarfId`
//   index (16 §4.3 `ObservedSessionStore.byIdentity`), the route's one lookup; a session no dwarf
//   carries yet is still noted, and its dialog's ask opens with the session's next evidence.
// - The evidence goes to the prompt registry (asking/adapters/observedClaude), which reads the
//   transcript tail and answers the asks to open and the calls resolved; this route applies them to
//   the broker in order: `open(dwarfId, input)` (idempotent by `(dwarfId, providerRequestId)`,
//   INV-71) and `resolveExternally(dwarfId, providerRequestId, 'elsewhere')`, whose attribution
//   window decides answered-in-app or answered-elsewhere (S6.11, S6.12).
// - Evidence, never a command (ADR-016 item 4): the route never answers an ask and never presses a
//   key. `accept` returns at once; the work runs after it, one event after another, and a failure is
//   recorded (`asking.hook-evidence.refused` for an open the broker refuses, such as a session whose
//   capability record does not detect permissions, 07 S1.17; `asking.hook-evidence.failed`
//   otherwise) and never reaches the ingress.
//
// Composed into the Host's main by ISSUE-140 (later), with the keystroke channel bound as the
// broker's `hook-keystroke` channel and `staleAnswerSafe` read from its capability record.
import { HostInvariantError } from '../../kernel/domain/errors'
import type { DwarfId, ProviderId } from '../../kernel/domain/values'
import type { DiagnosticsLog } from '../../kernel/ports/diagnosticsLog'
import type { AskBroker } from '../../modules/asking'
import type {
  PermissionPromptRegistry,
  PromptChange
} from '../../modules/asking/adapters/observedClaude/permissionPromptRegistry'
import type { ObservedSessionStore } from '../../modules/observation'
import type { ClaudeHookEvidence } from '../../transport/ingress/claudeHookPayload'
import type { ClaudeHookEvidenceSink } from '../../transport/ingress/claudeHooksRoute'

export interface ObservedClaudeAsksDeps {
  /** The catalog id the Claude hook events report on. */
  providerId: ProviderId
  /** Observation's `ProviderIdentity → DwarfId` index (16 §4.3). */
  sessions: Pick<ObservedSessionStore, 'byIdentity'>
  prompts: Pick<PermissionPromptRegistry, 'note'>
  asks: Pick<AskBroker, 'open' | 'resolveExternally'>
  log: DiagnosticsLog
}

/** The sink, and the promise of its work so far (for a caller that must wait for it). */
export interface ObservedClaudeAsks extends ClaudeHookEvidenceSink {
  idle(): Promise<void>
}

export function createObservedClaudeAsks(deps: ObservedClaudeAsksDeps): ObservedClaudeAsks {
  let work: Promise<void> = Promise.resolve()

  const dwarfOf = (sessionId: string | undefined): DwarfId | null =>
    sessionId === undefined
      ? null
      : (deps.sessions.byIdentity({ providerId: deps.providerId, providerSessionId: sessionId })
          ?.dwarfId ?? null)

  const apply = (change: PromptChange): void => {
    try {
      if (change.kind === 'open') deps.asks.open(change.dwarfId, change.input)
      else deps.asks.resolveExternally(change.dwarfId, change.providerRequestId, change.by)
    } catch (error) {
      deps.log.record({
        level: 'warn',
        event:
          error instanceof HostInvariantError
            ? 'asking.hook-evidence.refused'
            : 'asking.hook-evidence.failed',
        subsystem: 'asking',
        provider: deps.providerId,
        dwarfId: change.dwarfId
      })
    }
  }

  return {
    accept(evidence: ClaudeHookEvidence): void {
      let dwarfId: DwarfId | null
      try {
        dwarfId = dwarfOf(evidence.sessionId)
      } catch {
        dwarfId = null
      }
      let noted: Promise<PromptChange[]>
      try {
        // Now, not after the earlier work: the hook state must change the moment its evidence
        // arrives, so a keystroke check running meanwhile sees it (FM-082).
        noted = deps.prompts.note(evidence, dwarfId)
      } catch (error) {
        noted = Promise.reject(error instanceof Error ? error : new Error(String(error)))
      }
      work = work
        .then(() => noted)
        .then((changes) => changes.forEach(apply))
        .catch(() =>
          deps.log.record({
            level: 'warn',
            event: 'asking.hook-evidence.failed',
            subsystem: 'asking',
            provider: deps.providerId
          })
        )
    },
    idle: () => work
  }
}
