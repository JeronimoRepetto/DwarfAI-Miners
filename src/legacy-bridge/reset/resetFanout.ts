// `ResetFanout` (21 §3, cuts 1–3e; 21 §3.1; 14 §5): while two stores hold what "Reset metrics" wipes, the legacy
// runtime's and the Host's, A-33 runs both resets and answers `reset` only when both succeeded (BR-18; ADR-023 items
// 4–5). It is also A-33's shape adapter: the renderer calls it with the target shapes (`ResetMetricsParams` →
// `IpcResult<MetricsResetResult>`, 14 §2.1 A-33, §3.4), while the legacy reset keeps today's call and answer.
//
// - The request is checked again here with A-33's strict schema (`confirmed: 'yes'` and a `requestId`, ADR-019): a
//   request the seam A gate let through is still never a reset unless it is exactly that.
// - The legacy reset runs first, through `LegacyRuntimeRoute` (the only door to legacy code, R16). If it fails, the
//   Host saga does not start and A-33 answers `{outcome:'failed', reason, resumesOnNextStart: false}` with the legacy
//   reason (21 §3, revised 2026-09-30).
// - If it succeeds, `preferences.resetMetrics` (B-M15) is relayed on the `ui` connection with the renderer's own
//   `requestId` (14 §1.6), and A-33 answers the Host saga's result unchanged: `reset` with its `epoch`, or `failed`
//   with the saga's `resumesOnNextStart` (it resumes at the next Host boot). A Host call error is the IpcResult's
//   error branch (14 §1.5), never a throw into the renderer, so the toast never shows for a half reset.
// - A repeat of the same `requestId` within the Host's de-duplication window (10 min, 14 §1.6) joins the first call
//   or answers its settled result: the legacy reset runs once and the Host is reached once. A Host call error is not
//   a settled result, so a repeat after one relays again with the same `requestId` and the Host de-duplicates it.
//
// The Host saga's `ui-prefs` step (`ui.resetPreferences`) drives UI main's own store reset and A-N12, which ISSUE-061
// composes; this adapter neither waits for it nor touches a UI file or the login entry. Composed only by
// `src/ui-main/index.ts` (05 R16); routed by the cut-1 switch (ISSUE-123); deleted in 4a (ISSUE-236).
import {
  resetMetricsParamsSchema,
  type ChannelKey,
  type IpcError,
  type IpcResult,
  type MetricsResetResult,
  type StepId
} from '@dwarfai/contracts'
import type { RouteTarget } from '../../ui-main/ipc/router'
import type { HostClient } from '../../ui-main/window/ports/hostClient'

/** The name the route table lists and A-33's `legacy` + `target` route names (21 §3.1). */
export const RESET_FANOUT_NAME = 'ResetFanout'
/** The release steps it lives in: cuts 1–3e (21 §3, §3.1); from 4a only the Host saga runs. */
export const RESET_FANOUT_CUTS: readonly StepId[] = [
  'cut-1',
  'cut-2',
  'cut-3a',
  'cut-3b',
  'cut-3d',
  'cut-3e'
]
/** A-33, the one row it serves. */
export const RESET_METRICS = 'metrics:reset' satisfies ChannelKey
/** How long a `requestId` is remembered: the Host's in-memory de-duplication window (14 §1.6). */
export const REQUEST_MEMORY_MS = 600_000

/** The HostClient member the fan-out uses: the window's `ui` connection, or a short-lived one. */
export type ResetFanoutHostClient = Pick<HostClient, 'withUiConnection'>

export interface ResetFanoutDeps {
  /** `LegacyRuntimeRoute`: today's reset is its `metrics:reset` handler. */
  legacy: RouteTarget
  hostClient: ResetFanoutHostClient
  /** Epoch milliseconds, for the `requestId` window. */
  now(): number
}

/**
 * Today's text for a reset that did not happen (`AgentRuntime.resetMetrics`, `RESET_FAILED`): the reason of a legacy
 * failure that came without one. It stays true here, because a failed legacy reset starts no Host saga.
 */
const LEGACY_RESET_FAILED = 'The metrics could not be reset. Nothing was deleted.'

/** The legacy half's outcome: today's answer, reduced to whether the wipe reached disk. */
type LegacyOutcome = { reset: true } | { reset: false; reason: string }

/** One reset intent, by its `requestId`. */
interface Intent {
  /** When it was first asked, for the 10-min window. */
  readonly at: number
  /** The legacy reset, run once per intent. */
  readonly legacy: Promise<LegacyOutcome>
  /** The Host relay in flight or settled with a result; cleared by a call error so a repeat relays again. */
  host: Promise<IpcResult<MetricsResetResult>> | null
}

/** Today's answer of the `metrics:reset` handler: `{outcome:'reset'}`, or `{outcome:'failed', reason}`. */
function legacyOutcomeOf(answer: unknown): LegacyOutcome {
  const today = answer as { outcome?: unknown; reason?: unknown } | null
  if (today?.outcome === 'reset') return { reset: true }
  const reason = typeof today?.reason === 'string' && today.reason !== '' ? today.reason : null
  return { reset: false, reason: reason ?? LEGACY_RESET_FAILED }
}

/** A HostClient call error carries its seam-B error (14 §3.3); anything else is INTERNAL. */
function ipcErrorOf(error: unknown): IpcError {
  const carried = (error as { error?: Partial<IpcError> } | null)?.error
  return typeof carried?.code === 'string'
    ? (carried as IpcError)
    : { code: 'INTERNAL', message: 'the reset relay failed', retryable: false }
}

function refused(code: IpcError['code'], message: string): IpcResult<MetricsResetResult> {
  return { ok: false, error: { code, message, retryable: false } }
}

export function createResetFanout(deps: ResetFanoutDeps): RouteTarget {
  const { legacy, hostClient, now } = deps
  const intents = new Map<string, Intent>()

  /** Forgets every intent older than the Host's de-duplication window. */
  const forgetOld = (at: number): void => {
    for (const [requestId, intent] of intents) {
      if (at - intent.at >= REQUEST_MEMORY_MS) intents.delete(requestId)
    }
  }

  const runLegacy = (): Promise<LegacyOutcome> =>
    legacy.serve(RESET_METRICS, undefined).then(legacyOutcomeOf, () => ({
      reset: false,
      reason: LEGACY_RESET_FAILED
    }))

  const relay = (intent: Intent, requestId: string): Promise<IpcResult<MetricsResetResult>> => {
    const sent = hostClient
      .withUiConnection((ui) =>
        ui.call('preferences.resetMetrics', { confirmed: 'yes', requestId })
      )
      .then(
        (value): IpcResult<MetricsResetResult> => ({ ok: true, value }),
        (error: unknown): IpcResult<MetricsResetResult> => {
          intent.host = null
          return { ok: false, error: ipcErrorOf(error) }
        }
      )
    intent.host = sent
    return sent
  }

  return {
    async serve(channel, payload) {
      if (channel !== RESET_METRICS) return refused('METHOD_NOT_FOUND', `no route for ${channel}`)
      const request = resetMetricsParamsSchema.safeParse(payload)
      if (!request.success) return refused('INVALID_PARAMS', 'resetMetrics needs confirmed: yes')
      const { requestId } = request.data

      const at = now()
      forgetOld(at)
      let intent = intents.get(requestId)
      if (intent === undefined) {
        intent = { at, legacy: runLegacy(), host: null }
        intents.set(requestId, intent)
      }

      const legacyOutcome = await intent.legacy
      if (!legacyOutcome.reset) {
        const failed: MetricsResetResult = {
          outcome: 'failed',
          reason: legacyOutcome.reason,
          resumesOnNextStart: false
        }
        return { ok: true, value: failed } satisfies IpcResult<MetricsResetResult>
      }
      return intent.host ?? relay(intent, requestId)
    }
  }
}
