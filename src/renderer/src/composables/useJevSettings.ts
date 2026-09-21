import { ref } from 'vue'
import { DEFAULT_JEV_SETTINGS, type JevSettings } from '../types'

/**
 * State for Settings' Jev API-key control (#509).
 *
 * The same honesty rule `useNotificationSettings` and `usePinnedWindow` hold,
 * for the same reason: `settings` only ever becomes a value that came back
 * from main, because a save or a clear main refused must not be drawn as the
 * key being configured. Main is also the only process that ever sees the
 * plaintext key — this composable's `save` hands the typed value straight to
 * the preload and never keeps a copy — so `settings` is a reading and never
 * an authority, exactly like the switch it sits beside in Settings.
 *
 * No module-scope singleton: Settings is the only consumer, so per-call refs
 * keep tests independent without a clearAll() ritual.
 */
export function useJevSettings() {
  // Matches main's DEFAULT_JEV_SETTINGS so the first paint is almost always
  // right; sync() corrects it from the stored verdict after mount.
  const settings = ref<JevSettings>({ ...DEFAULT_JEV_SETTINGS })
  const saving = ref(false)

  /** Adopt the stored verdict; on failure keep the last known value. */
  async function sync(): Promise<void> {
    try {
      settings.value = await window.api.getJevSettings()
    } catch {
      // The bridge is unreachable: the last known value is still the most
      // honest thing to render, and the next successful call corrects it.
    }
  }

  /**
   * Ask main to enter or replace the key. A second call while one is in
   * flight is ignored — a double-click must not fire two racing writes whose
   * answers could land out of order and leave the section drawn at the older
   * one.
   */
  async function save(key: string): Promise<void> {
    if (saving.value) return
    saving.value = true
    try {
      settings.value = await window.api.setJevApiKey(key)
    } catch {
      // The failed write may or may not have reached main before breaking:
      // re-read the real state rather than assume either outcome.
      await sync()
    } finally {
      saving.value = false
    }
  }

  /** Ask main to forget the key. Same in-flight guard as save(). */
  async function clear(): Promise<void> {
    if (saving.value) return
    saving.value = true
    try {
      settings.value = await window.api.clearJevApiKey()
    } catch {
      await sync()
    } finally {
      saving.value = false
    }
  }

  return { settings, saving, sync, save, clear }
}
