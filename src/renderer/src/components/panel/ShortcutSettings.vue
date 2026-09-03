<script setup lang="ts">
import { computed, onMounted, ref, useId } from 'vue'
import { DEFAULT_TOGGLE_ACCELERATOR, formatAccelerator } from '../../../../shared/accelerator'
import type { ShortcutState } from '../../types'

/**
 * The Panel shortcut section of the redesigned Settings screen (#138,
 * screens/settings.md) — the global panel-toggle shortcut, with a recorder
 * that listens for a key combination.
 *
 * REHOSTED from the interim titlebar-era settings overlay (#17, #142): the
 * capture logic below is unchanged, but this is now a plain section inside
 * SettingsPanel rather than its own dialog. Its `role="dialog"` and the
 * header it drew (a "Settings" title plus its own close button) are GONE —
 * both belonged to the old overlay, and #142 already flagged the dialog role
 * as stale for a component that is now one section of a full-page screen. The
 * design gives the whole screen its own title/divider (drawn once, by
 * SettingsPanel), and leaving Settings is selecting another nav area, exactly
 * like leaving Map or Mines — there is no per-section close button to draw.
 * The Escape-to-close keydown handler stays: it is still a reasonable way out
 * of a listening recorder, and ShortcutSettings.test.ts still pins it.
 *
 * Presentational on purpose, like DwarfActionBar: every piece of state arrives
 * as a prop and every intent leaves as an event. App.vue owns useToggleShortcut
 * and therefore owns the IPC. That is what lets this component be tested
 * without a window.api stub, and it keeps the "only render what main verified"
 * rule in exactly one place.
 */

const props = defineProps<{
  /** The verified state from main, or null while it is still being read. */
  state: ShortcutState | null
  /** Why the last attempt failed — from main, or from a locally refused chord. */
  error: string | null
  recording: boolean
  applying: boolean
}>()

const emit = defineEmits<{
  'start-recording': []
  'stop-recording': []
  /** One keydown captured by the recorder; the owner translates and applies it. */
  record: [event: KeyboardEvent]
  reset: []
  close: []
}>()

// Generated rather than hardcoded: the panel is a singleton today, but a fixed
// id turns into a silent accessibility bug the moment that stops being true.
const labelId = useId()
const valueId = useId()
const hintId = useId()

const recorderRef = ref<HTMLButtonElement | null>(null)

/** Nothing is operable until the real state has arrived, or while it is changing. */
const busy = computed(() => props.applying || props.state === null)

const recorderText = computed(() => {
  if (props.recording) return 'Press a combination...'
  if (props.state === null) return 'Checking...'
  // The wire spelling ('Control+Alt+Shift+P') is never shown to a human.
  return formatAccelerator(props.state.accelerator, props.state.platform)
})

/**
 * The one line that must never lie: a combination the OS refused is reported
 * as unavailable, never as active, however tidy the button above it looks.
 */
const hint = computed(() => {
  if (props.recording) return 'Listening - press a combination, or Escape to cancel.'
  if (props.state === null) return 'Reading the current shortcut...'
  if (props.applying) return 'Applying...'
  if (!props.state.registered) {
    return 'Unavailable - another application owns this combination. Click to record a different one.'
  }
  // Exact copy from screens/settings.md — not "the panel" as the interim
  // overlay had it.
  return 'Active - press it anywhere to show or hide panel.'
})

/**
 * Resetting is only pointless when the default is BOTH selected and working:
 * with a failed registration the same click is how the user retries, once
 * whatever owned the combination has quit.
 */
const resetDisabled = computed(
  () =>
    busy.value ||
    (props.state !== null &&
      props.state.accelerator === DEFAULT_TOGGLE_ACCELERATOR &&
      props.state.registered)
)

function onRecorderClick(): void {
  if (props.recording) emit('stop-recording')
  else emit('start-recording')
}

function onRecorderKeydown(event: KeyboardEvent): void {
  // While listening the recorder consumes the keystroke completely, so Escape
  // cancels the recording WITHOUT also reaching the section's own close
  // handler — changing your mind about a chord must not cost you the panel.
  if (props.recording) event.stopPropagation()
  emit('record', event)
}

// A keyboard user opening settings lands directly on the control they came for.
onMounted(() => recorderRef.value?.focus())
</script>

<template>
  <section class="shortcut-settings" @keydown.escape="emit('close')">
    <span :id="labelId" class="field-label">Panel shortcut</span>
    <!--
      The accessible name is the field label plus the current value, so a
      screen reader announces "Panel shortcut, Ctrl + Alt + Shift + P" rather
      than a bare combination; aria-pressed carries the listening state and
      the hint below is wired up as the description.
    -->
    <button
      ref="recorderRef"
      class="recorder"
      :class="{ 'is-recording': recording, 'is-broken': state !== null && !state.registered }"
      type="button"
      :disabled="busy"
      :aria-pressed="recording ? 'true' : 'false'"
      :aria-labelledby="`${labelId} ${valueId}`"
      :aria-describedby="hintId"
      @click="onRecorderClick"
      @keydown="onRecorderKeydown"
    >
      <span :id="valueId">{{ recorderText }}</span>
    </button>
    <p :id="hintId" class="hint" role="status">{{ hint }}</p>
    <p v-if="error" class="settings-error" role="alert">{{ error }}</p>
    <button class="reset" type="button" :disabled="resetDisabled" @click="emit('reset')">
      Reset to default
    </button>
  </section>
</template>

<style scoped>
/* screens/settings.md's Panel shortcut section: one plain section inside
   SettingsPanel now, not an overlay — the frame and heavy border belong to
   the panel-frame variant this mounts inside. */
.shortcut-settings {
  display: flex;
  flex-direction: column;
  gap: var(--space-settings);
}
.field-label {
  padding-top: var(--space-settings);
  color: var(--color-cream);
  font-size: var(--text-section);
}
.recorder {
  width: 100%;
  height: var(--size-shortcut-height);
  padding: 0 var(--space-settings);
  border: var(--border-active);
  border-radius: var(--radius-default);
  color: var(--color-cream);
  cursor: pointer;
  background: var(--color-control);
  font: inherit;
  font-size: var(--text-meta);
  font-variant-numeric: tabular-nums;
  text-align: center;
}
.recorder:disabled {
  cursor: default;
  opacity: 0.6;
}
/* Listening/broken are Unspecified by the design (foundations.md) — kept on
   the app's existing lantern/danger tokens rather than inventing a design
   colour for a state the source never draws. */
.recorder.is-recording {
  border-color: var(--lantern);
  color: var(--lantern);
  animation: recorder-pulse 1.2s ease-in-out infinite;
}
.recorder.is-broken {
  border-color: var(--danger-line);
  color: var(--danger-ink);
}
.recorder:hover:not(:disabled) {
  border-color: var(--lantern);
}
.recorder:focus-visible,
.reset:focus-visible {
  outline: 2px solid var(--color-cream);
  outline-offset: 2px;
}
.hint {
  margin: 0;
  color: var(--color-cream);
  font-size: var(--text-helper);
  line-height: 1.4;
}
.settings-error {
  margin: 0;
  padding: 7px 8px;
  border-left: 3px solid var(--danger-line);
  border-radius: 4px;
  color: var(--danger-ink);
  background: var(--danger-bg);
  font-size: var(--text-helper);
  line-height: 1.4;
}
/* Reset to default reuses the shared button/segmented-control model
   (components.md): enabled looks like an active control, disabled fades to
   the deep background — pointless once the default is already working. */
.reset {
  align-self: flex-start;
  padding: 6px var(--space-settings);
  border: var(--border-active);
  border-radius: var(--radius-default);
  color: var(--color-cream);
  cursor: pointer;
  background: var(--color-control);
  font: inherit;
  font-size: var(--text-meta);
}
.reset:disabled {
  cursor: default;
  border: 2px solid var(--color-control);
  color: var(--color-control);
  background: var(--color-panel-deep);
}
@keyframes recorder-pulse {
  50% {
    border-color: #fff2cc;
  }
}
</style>
