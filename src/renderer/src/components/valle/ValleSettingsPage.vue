<script setup lang="ts">
/*
 * The Settings page over Valle's main zone (07 S28.19; UC-069; ISSUE-304; owner decision 2026-10-22): the Panel's own
 * page (`SettingsPanel`), fed by the same container (`useSettingsPage`) scoped to the Valle window.
 *
 * - Position, Always on top and Hide panel are absent: they act on the Panel window.
 * - The Sound rows only change the stored settings: no playback and no audio engine in the Valle window until
 *   US-VALLE-016.
 * - Every other row (the panel shortcut, Mode at launch, notifications, typography, Jev, OpenCode, Reset metrics,
 *   About) appears and acts as in the Panel; its reads start when the page opens and stop when it leaves, as the
 *   Panel's start and stop with its window.
 * - The shortcut recorder's own close leaves the page (`close`), as Esc does (S28.20).
 */
import { onBeforeUnmount, onMounted } from 'vue'
import { useSettingsPage } from '../../composables/useSettingsPage'
import SettingsPanel from '../panel/SettingsPanel.vue'

const emit = defineEmits<{ close: [] }>()

const page = useSettingsPage({ window: 'valle' })
const audio = page.audio!
const audioSettings = audio.settings
const {
  enabled: notificationsEnabled,
  sync: syncNotifications,
  start: followNotifications,
  stop: stopFollowingNotifications,
  set: setNotificationsEnabled
} = page.notifications
const {
  options: modeAtLaunchOptions,
  value: modeAtLaunchValue,
  read: readModeAtLaunch,
  pick: pickModeAtLaunch,
  dispose: disposeModeAtLaunch
} = page.modeAtLaunch
const {
  settings: jevSettings,
  saving: jevSaving,
  providers: jevProviders,
  catalogs: jevCatalogs,
  sync: syncJev,
  start: followJev,
  stop: stopFollowingJev,
  save: saveJevApiKey,
  clear: clearJevApiKey,
  setPreferences: setJevPreferences
} = page.jev
const {
  view: openCodeSettings,
  applying: openCodeApplying,
  sync: syncOpenCode,
  start: followOpenCode,
  stop: stopFollowingOpenCode,
  setPluginEnabled: setOpenCodePluginEnabled,
  savePassword: saveOpenCodeServerPassword,
  clearPassword: clearOpenCodeServerPassword
} = page.openCode
const {
  preferences: typography,
  applying: typographyApplying,
  sync: syncTypography,
  set: setTypography,
  listen: listenTypography
} = page.typography
const {
  state: shortcutState,
  error: shortcutError,
  recording: shortcutRecording,
  applying: shortcutApplying,
  sync: syncShortcut,
  startRecording,
  stopRecording,
  record: recordShortcut,
  reset: resetShortcut
} = page.shortcut
const { resetting, error: resetError, reset: resetMetrics } = page.resetMetrics
const { versionText, versionHint, loadBuild } = page

let unlistenTypography: (() => void) | undefined
onMounted(() => {
  void audio.read()
  void syncShortcut()
  void loadBuild()
  void syncNotifications()
  void followNotifications()
  void syncTypography()
  unlistenTypography = listenTypography()
  void syncJev()
  void followJev()
  void syncOpenCode()
  void followOpenCode()
  void readModeAtLaunch()
})
onBeforeUnmount(() => {
  // A recorder left listening would capture keystrokes after the page left.
  stopRecording()
  unlistenTypography?.()
  stopFollowingNotifications()
  stopFollowingJev()
  stopFollowingOpenCode()
  disposeModeAtLaunch()
})
</script>

<template>
  <div class="dm-vhosted" data-valle-hosted="settings">
    <SettingsPanel
      :panel-window-rows="page.panelWindowRows"
      :shortcut-state="shortcutState"
      :shortcut-error="shortcutError"
      :shortcut-recording="shortcutRecording"
      :shortcut-applying="shortcutApplying"
      :version-text="versionText"
      :version-hint="versionHint"
      :resetting="resetting"
      :reset-error="resetError"
      :audio-settings="audioSettings"
      :notifications-enabled="notificationsEnabled"
      :typography="typography"
      :typography-applying="typographyApplying"
      :jev-settings="jevSettings"
      :jev-saving="jevSaving"
      :jev-providers="jevProviders"
      :jev-catalogs="jevCatalogs"
      :open-code-settings="openCodeSettings"
      :open-code-applying="openCodeApplying"
      :mode-at-launch="modeAtLaunchValue"
      :mode-at-launch-options="modeAtLaunchOptions"
      @mode-at-launch-change="pickModeAtLaunch"
      @start-recording="startRecording"
      @stop-recording="stopRecording"
      @record="recordShortcut"
      @reset-shortcut="resetShortcut"
      @close="emit('close')"
      @reset-confirm="resetMetrics"
      @audio-change="(patch) => void audio.write(patch)"
      @notifications-change="setNotificationsEnabled"
      @typography-change="setTypography"
      @jev-save="saveJevApiKey"
      @jev-clear="clearJevApiKey"
      @jev-preferences-change="setJevPreferences"
      @opencode-plugin-change="setOpenCodePluginEnabled"
      @opencode-password-save="saveOpenCodeServerPassword"
      @opencode-password-clear="clearOpenCodeServerPassword"
    />
  </div>
</template>

<style scoped>
.dm-vhosted {
  display: grid;
  grid-template: minmax(0, 1fr) / minmax(0, 1fr);
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: auto;
}
</style>
