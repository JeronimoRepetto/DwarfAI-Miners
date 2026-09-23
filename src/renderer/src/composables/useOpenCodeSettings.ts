import { ref } from 'vue'
import { DEFAULT_OPENCODE_SETTINGS, type OpenCodeSettings } from '../types'

/**
 * State for Settings' OpenCode section (#588 T6): the permission-relay
 * consent and the optional server password.
 *
 * The honesty rule `useNotificationSettings` and `useJevSettings` hold, for
 * the same reason: `settings` only ever becomes a value main answered with.
 * A relay main could not turn on comes back as `pluginEnabled: false` with a
 * `pluginError`, and is drawn exactly that way. The password is handed
 * straight to the preload by `savePassword` and never kept here; nothing
 * main answers ever carries it.
 *
 * One `applying` flag for the whole section, like `useJevSettings`' single
 * `saving`: the switch and the password are one section, and a second request
 * racing the first could land out of order and draw the older answer.
 */
export function useOpenCodeSettings() {
  const settings = ref<OpenCodeSettings>({ ...DEFAULT_OPENCODE_SETTINGS })
  const applying = ref(false)

  /** Adopt the stored verdict; on failure keep the last known value. */
  async function sync(): Promise<void> {
    try {
      settings.value = await window.api.getOpenCodeSettings()
    } catch {
      // The bridge is unreachable: the last known value is still the most
      // honest thing to render, and the next successful call corrects it.
    }
  }

  async function run(request: () => Promise<OpenCodeSettings>): Promise<void> {
    if (applying.value) return
    applying.value = true
    try {
      settings.value = await request()
    } catch {
      // The failed write may or may not have reached main before breaking:
      // re-read the real state rather than assume either outcome.
      await sync()
    } finally {
      applying.value = false
    }
  }

  function setPluginEnabled(enabled: boolean): Promise<void> {
    return run(() => window.api.setOpenCodePluginEnabled(enabled))
  }

  function savePassword(password: string): Promise<void> {
    return run(() => window.api.setOpenCodeServerPassword(password))
  }

  function clearPassword(): Promise<void> {
    return run(() => window.api.clearOpenCodeServerPassword())
  }

  return { settings, applying, sync, setPluginEnabled, savePassword, clearPassword }
}
