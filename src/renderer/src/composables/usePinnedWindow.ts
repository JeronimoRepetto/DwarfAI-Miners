import { ref } from 'vue'

/**
 * State for the titlebar pin control (see #35). The single honesty rule this
 * composable exists to enforce: `pinned` only ever changes to a value that
 * came back from the main process (a set verdict or a get), because the
 * platform can decline an always-on-top change — the icon must show what the
 * BrowserWindow actually is, never what the click wished for.
 *
 * Unlike useDwarfMessaging/useDwarfKicking there is no module-scope singleton:
 * the titlebar is the only consumer, so each call owning fresh refs keeps
 * tests independent without a clearAll() ritual.
 */
export function usePinnedWindow() {
  // Matches main's DEFAULT_PINNED so the first paint is almost always right;
  // sync() corrects it from the real window state right after mount.
  const pinned = ref(true)
  const toggling = ref(false)

  /** Adopt the window's real state; on failure keep the last known one. */
  async function sync(): Promise<void> {
    try {
      pinned.value = await window.api.getAlwaysOnTop()
    } catch {
      // The bridge is unreachable: the last known state is still the most
      // honest thing we can render, and the next successful call corrects it.
    }
  }

  /**
   * Ask main for the opposite state. A second click while one is in flight is
   * ignored — a double-click must not fire two racing toggles whose verdicts
   * could land out of order.
   */
  async function toggle(): Promise<void> {
    if (toggling.value) return
    toggling.value = true
    try {
      pinned.value = await window.api.setAlwaysOnTop(!pinned.value)
    } catch {
      // The failed toggle may or may not have reached the window before
      // breaking: re-read the actual state rather than assume either outcome.
      await sync()
    } finally {
      toggling.value = false
    }
  }

  return { pinned, toggling, sync, toggle }
}
