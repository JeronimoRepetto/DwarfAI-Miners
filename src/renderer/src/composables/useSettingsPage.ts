/*
 * The Settings page in use (#17, #79, #138, #316, #370, #509, #588; ISSUE-234, ISSUE-294): the read models and actions
 * its sections draw — the panel shortcut, Reset metrics, the build, the notifications switch, Jev, OpenCode, the faces
 * the app is drawn in and Mode at launch. Moved out of `App.vue` for ISSUE-304, with no change to the Panel: each part
 * is "a reading and never an authority" (main or the Host owns the value; this only draws what it answered), and
 * `SettingsPanel` stays presentational.
 *
 * What it does not hold, deliberately: the sound (`useAudio`), the Panel's dock edge (`usePanelLayout`) and its pin
 * (`usePinnedWindow`), which the Panel shell shares with other surfaces. A Valle Settings page waits on the owner's
 * ruling on those Panel-window rows (ISSUE-304 hand-off).
 *
 * The caller starts and stops the follows at its own mount (`sync…`, `follow…`, `stopFollowing…`, `dispose…`).
 */
import { computed, ref, type Ref } from 'vue'
import { versionLabel, versionTitle } from '../lib/appBuild'
import type { AppBuild } from '../types'
import { useJevSettings } from './useJevSettings'
import { modeAtLaunchPart } from './useModeAtLaunch'
import { useNotificationSettings } from './useNotificationSettings'
import { useOpenCodeSettings } from './useOpenCodeSettings'
import { useResetMetrics } from './useResetMetrics'
import { useToggleShortcut } from './useToggleShortcut'
import { useTypography } from './useTypography'

export interface SettingsPageDeps {
  /** Whether the Panel stays above other windows, as main answered (`usePinnedWindow`). */
  pinned: Readonly<Ref<boolean>>
}

export function useSettingsPage(deps: SettingsPageDeps) {
  /**
   * Settings' notifications switch (#316): main raises a notification, so it owns the switch and this only draws what
   * it answered with.
   */
  const notifications = useNotificationSettings()

  /** Settings › General "Mode at launch" (US-SET-002.AC09): the options this build ships, and what UI main stored. */
  const modeAtLaunch = modeAtLaunchPart()

  /** Settings' Jev API-key control (#509): main is the only process that ever sees the plaintext key. */
  const jev = useJevSettings()

  /**
   * Settings' OpenCode section (#588 T6; ISSUE-234): the Host's `OpenCodeSettingsView` read model; the password is
   * handed to the preload and never kept here.
   */
  const openCode = useOpenCodeSettings()

  /**
   * Which faces the app is drawn in (#370): the composable repoints two custom properties on its own document, so each
   * window paints itself.
   */
  const typography = useTypography()

  // The hover line explains what the CURRENT state does; the accessible name stays stable and aria-pressed carries the
  // state.
  const pinTooltip = computed(() =>
    deps.pinned.value
      ? 'Pinned: the panel stays above other windows'
      : 'Unpinned: other windows can cover the panel'
  )

  /** The panel shortcut (#17): only what main verified is drawn. */
  const shortcut = useToggleShortcut()

  /** Settings' "Reset metrics" action (#138): only what main verified is drawn. */
  const resetMetrics = useResetMetrics()

  /**
   * Which build is running (#79), read from main once on mount: a version cannot change under a live process. Null
   * until it arrives, and null forever if the read fails, in which case the page prints nothing at all.
   */
  const build = ref<AppBuild | null>(null)
  const versionText = computed(() => (build.value === null ? null : versionLabel(build.value)))
  const versionHint = computed(() => (build.value === null ? '' : versionTitle(build.value)))
  async function loadBuild(): Promise<void> {
    try {
      build.value = await window.api.getAppBuild()
    } catch {
      // Main is the only source there is: nothing to fall back on and nothing worth guessing.
    }
  }

  return {
    notifications,
    modeAtLaunch,
    jev,
    openCode,
    typography,
    pinTooltip,
    shortcut,
    resetMetrics,
    versionText,
    versionHint,
    loadBuild
  }
}
