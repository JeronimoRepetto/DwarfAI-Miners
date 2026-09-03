import { ref } from 'vue'

/**
 * State for Settings' "Reset metrics" action (#138). App owns this composable
 * — and therefore the IPC — for the same reason it owns useToggleShortcut and
 * usePanelLayout: the reset modal stays presentational, and the "render only
 * what main verified" rule lives in exactly one place.
 *
 * No module-scope singleton: the modal is a singleton on screen today, but a
 * fixed store would be one more thing to reset between tests for no benefit.
 */
export function useResetMetrics() {
  const resetting = ref(false)
  const error = ref<string | null>(null)

  /**
   * Ask main to wipe the ledger. A call while one is already in flight is
   * ignored — Confirm is a destructive, irreversible action, and a double
   * click must never fire it twice. Resolves true exactly when main reports
   * the wipe reached disk.
   */
  async function reset(): Promise<boolean> {
    if (resetting.value) return false
    resetting.value = true
    try {
      const result = await window.api.resetMetrics()
      error.value = result.outcome === 'reset' ? null : (result.reason ?? null)
      return result.outcome === 'reset'
    } catch {
      error.value = 'The panel lost contact with the app. Nothing was deleted.'
      return false
    } finally {
      resetting.value = false
    }
  }

  return { resetting, error, reset }
}
