<script setup lang="ts">
import { ref } from 'vue'
import type { PanelEdge, ShortcutState } from '../../types'
import DataBaseSection from './DataBaseSection.vue'
import PositionSettings from './PositionSettings.vue'
import ResetMetricsModal from './ResetMetricsModal.vue'
import ShortcutSettings from './ShortcutSettings.vue'

/**
 * The redesigned Settings screen (#138, screens/settings.md), replacing the
 * interim framed mount #142 left behind. Mounts inside PanelFrame's
 * 'settings' variant (the 4px cream border already lives there); this
 * component draws only what is specific to Settings — the "Settings" title
 * and its divider — then every section in the design's order: Panel
 * shortcut, Position, Data Base.
 *
 * Presentational, like every settings piece: every verdict arrives as a prop
 * and every intent leaves as an event, so App.vue keeps owning the IPC (the
 * shortcut, the panel layout, the pin, the reset) and the "render only what
 * main verified" rule stays in exactly one place. The one thing kept LOCAL
 * here is whether the reset modal is open — pure display state nothing
 * outside this screen ever needs to read.
 *
 * The "Application" section (pin, hide panel, version) is an UNSPECIFIED
 * placement decision (#138): the design draws no home for any of the three,
 * #142 parked them in the interim settings mount, and this slice gives them
 * the design's own control styling in a small grouped section rather than
 * leaving them as unstyled furniture.
 */
defineProps<{
  shortcutState: ShortcutState | null
  shortcutError: string | null
  shortcutRecording: boolean
  shortcutApplying: boolean
  edge: PanelEdge
  /** True while a layout move (including a position change) is in flight. */
  edgeApplying: boolean
  pinned: boolean
  pinTooltip: string
  /** Null until main's build answer arrives, and null forever on failure — see App.vue. */
  versionText: string | null
  versionHint: string
  /** True while main is processing a confirmed reset. */
  resetting: boolean
  /** Why the last reset attempt failed; null once nothing has gone wrong. */
  resetError: string | null
}>()

const emit = defineEmits<{
  'start-recording': []
  'stop-recording': []
  record: [event: KeyboardEvent]
  'reset-shortcut': []
  close: []
  'select-edge': [edge: PanelEdge]
  'toggle-pin': []
  'hide-panel': []
  'reset-confirm': []
}>()

const resetModalOpen = ref(false)
</script>

<template>
  <div class="settings-panel">
    <header class="settings-head">
      <h1 class="settings-title">Settings</h1>
      <div class="settings-divider" role="presentation"></div>
    </header>

    <ShortcutSettings
      :state="shortcutState"
      :error="shortcutError"
      :recording="shortcutRecording"
      :applying="shortcutApplying"
      @start-recording="emit('start-recording')"
      @stop-recording="emit('stop-recording')"
      @record="emit('record', $event)"
      @reset="emit('reset-shortcut')"
      @close="emit('close')"
    />

    <PositionSettings :edge="edge" :applying="edgeApplying" @select="emit('select-edge', $event)" />

    <DataBaseSection @open-reset="resetModalOpen = true" />

    <section class="application-settings">
      <span class="field-label">Application</span>
      <div class="application-controls">
        <button
          class="pin"
          type="button"
          aria-label="Keep panel on top"
          :aria-pressed="pinned ? 'true' : 'false'"
          :title="pinTooltip"
          @click="emit('toggle-pin')"
        >
          Always on top
        </button>
        <button
          class="hide-panel"
          type="button"
          title="Hide the panel; the shortcut or the tray brings it back"
          @click="emit('hide-panel')"
        >
          Hide panel
        </button>
        <span v-if="versionText" class="version" :title="versionHint">{{ versionText }}</span>
      </div>
    </section>

    <ResetMetricsModal
      v-if="resetModalOpen"
      :confirming="resetting"
      :error="resetError"
      @confirm="emit('reset-confirm')"
      @close="resetModalOpen = false"
    />
  </div>
</template>

<style scoped>
/* screens/settings.md's Panel frame: center content alignment; the 4px
   border/radius/margin/background live on PanelFrame's 'settings' variant,
   this only draws what is unique to the Settings screen itself. */
.settings-panel {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--space-settings);
  height: 100%;
  padding: var(--space-settings);
  overflow: auto;
  font-family: var(--font-pixel);
}
.settings-head {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.settings-title {
  margin: 0;
  color: var(--color-accent);
  font: inherit;
  font-size: var(--text-title);
  text-align: start;
}
.settings-divider {
  height: 2px;
  background: var(--color-accent);
}
.application-settings {
  display: flex;
  flex-direction: column;
  gap: var(--space-settings);
  /* The design draws nothing here (#142's unspecified placement); pushed to
     the bottom of the scroll area so it reads as furniture, not a fourth
     designed section. */
  margin-top: auto;
}
.field-label {
  padding-top: var(--space-settings);
  color: var(--color-cream);
  font-size: var(--text-section);
}
.application-controls {
  display: flex;
  align-items: center;
  gap: var(--space-settings);
}
.pin,
.hide-panel {
  padding: 6px var(--space-settings);
  border: var(--border-active);
  border-radius: var(--radius-default);
  color: var(--color-cream);
  background: var(--color-control);
  font: inherit;
  font-size: var(--text-meta);
  cursor: pointer;
}
.pin[aria-pressed='false'] {
  border: 2px solid var(--color-control);
  color: var(--color-control);
  background: var(--color-panel-deep);
}
.pin:focus-visible,
.hide-panel:focus-visible {
  outline: 2px solid var(--color-cream);
  outline-offset: 2px;
}
.version {
  color: var(--color-accent);
  font-size: var(--text-meta);
}
</style>
