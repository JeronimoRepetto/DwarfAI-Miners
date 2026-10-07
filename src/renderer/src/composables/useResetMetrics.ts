import { ref } from 'vue'
import { mintRequestId } from './requestIds'
import { useHostConnection } from './useHostConnection'

/** What the panel says when the answer never came, or came as an error: today's own line for a lost round trip. */
const LOST_CONTACT = 'The panel lost contact with the app. Nothing was deleted.'

export interface ResetMetricsDeps {
  /** A UUIDv7 per reset intent (14 §1.6); the default mints one from the clock and the platform's random source. */
  newRequestId?: () => string
}

/**
 * State for Settings' "Reset metrics" action (#138). App owns this composable
 * — and therefore the IPC — for the same reason it owns useToggleShortcut and
 * usePanelLayout: the reset modal stays presentational, and the "render only
 * what main verified" rule lives in exactly one place.
 *
 * No module-scope singleton: the modal is a singleton on screen today, but a
 * fixed store would be one more thing to reset between tests for no benefit.
 */
export function useResetMetrics(deps: ResetMetricsDeps = {}) {
  const { newRequestId = mintRequestId } = deps
  const resetting = ref(false)
  const error = ref<string | null>(null)

  /**
   * Ask main to wipe the ledger. A call while one is already in flight is
   * ignored — Confirm is a destructive, irreversible action, and a double
   * click must never fire it twice. Resolves true exactly when main reports
   * the wipe reached disk.
   */
  async function reset(): Promise<boolean> {
    // Read-only while the Host is not connected (ADR-002 D9; 13 FM-146): nothing leaves.
    if (useHostConnection().readOnly.value) return false
    if (resetting.value) return false
    resetting.value = true
    try {
      // A-33 in its target shape from the cut-1 switch (ISSUE-123; 14 §2.1 A-33, §3.4): the typed confirmation and one
      // request id for this intent, answered `IpcResult<MetricsResetResult>` once both resets ran (`ResetFanout`).
      const result = await window.api.resetMetrics({ confirmed: 'yes', requestId: newRequestId() })
      if (!result.ok) {
        error.value = LOST_CONTACT
        return false
      }
      const outcome = result.value
      error.value = outcome.outcome === 'reset' ? null : outcome.reason
      return outcome.outcome === 'reset'
    } catch {
      error.value = LOST_CONTACT
      return false
    } finally {
      resetting.value = false
    }
  }

  return { resetting, error, reset }
}
