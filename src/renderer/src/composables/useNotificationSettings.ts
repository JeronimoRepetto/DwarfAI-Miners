import { ref } from 'vue'
import { DEFAULT_NOTIFICATIONS_ENABLED } from '../types'

/**
 * State for Settings' notifications switch (#316).
 *
 * The same honesty rule `usePinnedWindow` enforces for the pin, and for the
 * same reason: `enabled` only ever changes to a value that came back from main,
 * because a press main refused or could not store must not be drawn as the
 * state in force. Main is also the only process that acts on this — it is main
 * that raises the notification — so the renderer's copy is a reading and never
 * an authority.
 *
 * No module-scope singleton: Settings is the only consumer, so per-call refs
 * keep tests independent without a clearAll() ritual.
 */
export function useNotificationSettings() {
  // Matches main's DEFAULT_NOTIFICATIONS_ENABLED so the first paint is almost
  // always right; sync() corrects it from the stored preference after mount.
  const enabled = ref(DEFAULT_NOTIFICATIONS_ENABLED)
  const applying = ref(false)

  /** Adopt the stored switch; on failure keep the last known value. */
  async function sync(): Promise<void> {
    try {
      enabled.value = await window.api.getNotificationsEnabled()
    } catch {
      // The bridge is unreachable: the last known value is still the most
      // honest thing to render, and the next successful call corrects it.
    }
  }

  /**
   * Ask main for a state. A second press while one is in flight is ignored — a
   * double-click must not fire two racing writes whose answers could land out
   * of order and leave the switch drawn at the older one.
   */
  async function set(next: boolean): Promise<void> {
    if (applying.value) return
    applying.value = true
    try {
      enabled.value = await window.api.setNotificationsEnabled(next)
    } catch {
      // The failed write may or may not have reached main before breaking:
      // re-read the real state rather than assume either outcome.
      await sync()
    } finally {
      applying.value = false
    }
  }

  return { enabled, applying, sync, set }
}
