<script setup lang="ts">
import { computed, onMounted, ref, useId } from 'vue'
import { DEFAULT_TOGGLE_ACCELERATOR, formatAccelerator } from '../../../../shared/accelerator'
import type { ShortcutState } from '../../../../shared/contracts'

/**
 * The settings panel behind the titlebar gear (see #17). Today it holds one
 * setting — the global panel-toggle shortcut — with a recorder that listens
 * for a key combination.
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
  return 'Active - press it anywhere to show or hide the panel.'
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
  // cancels the recording WITHOUT also reaching the dialog's close handler —
  // changing your mind about a chord must not cost you the panel.
  if (props.recording) event.stopPropagation()
  emit('record', event)
}

// A keyboard user opening settings lands directly on the control they came for.
onMounted(() => recorderRef.value?.focus())
</script>

<template>
  <div
    class="shortcut-settings"
    role="dialog"
    aria-label="Settings"
    @keydown.escape="emit('close')"
  >
    <header class="settings-head">
      <h2 class="settings-title">Settings</h2>
      <button
        class="close-settings"
        type="button"
        aria-label="Close settings"
        @click="emit('close')"
      >
        &times;
      </button>
    </header>
    <div class="field">
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
    </div>
  </div>
</template>

<style scoped>
.shortcut-settings {
  /* Anchored under the titlebar, above the mine scene, inside the panel's
     relative box — the same overlay approach the feed modal uses. */
  position: absolute;
  z-index: 95;
  top: 44px;
  right: 10px;
  left: 10px;
  padding: 10px 12px 12px;
  border: 1px solid var(--line-strong);
  border-radius: 10px;
  background: var(--bg-panel);
  box-shadow: 0 10px 24px rgb(0 0 0 / 45%);
}
.settings-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}
.settings-title {
  margin: 0;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.04em;
}
.close-settings {
  padding: 0 6px;
  border: 0;
  border-radius: 6px;
  color: var(--ink-dim);
  cursor: pointer;
  background: transparent;
  font: inherit;
  font-size: 18px;
  line-height: 1;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.field-label {
  color: var(--ink-dim);
  font-size: 11px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.recorder {
  padding: 8px 10px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  color: var(--ink);
  cursor: pointer;
  background: #2b2119;
  font: inherit;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  text-align: center;
}
.recorder:disabled {
  cursor: default;
  opacity: 0.6;
}
/* Listening is a state the user must not have to guess at: the lantern accent
   plus a pulse says the keyboard is being captured right now. */
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
.reset:focus-visible,
.close-settings:focus-visible {
  outline: 2px solid #ffe29c;
  outline-offset: 2px;
}
.hint {
  margin: 0;
  color: var(--ink-dim);
  font-size: 11px;
  line-height: 1.4;
}
.settings-error {
  margin: 0;
  padding: 7px 8px;
  border-left: 3px solid var(--danger-line);
  border-radius: 4px;
  color: var(--danger-ink);
  background: var(--danger-bg);
  font-size: 11px;
  line-height: 1.4;
}
.reset {
  align-self: flex-start;
  margin-top: 2px;
  padding: 5px 9px;
  border: 1px solid var(--line-soft);
  border-radius: 6px;
  color: var(--ink-dim);
  cursor: pointer;
  background: transparent;
  font: inherit;
  font-size: 11px;
}
.reset:hover:not(:disabled) {
  color: #fff;
  background: #4b3c28;
}
.reset:disabled {
  cursor: default;
  opacity: 0.45;
}
@keyframes recorder-pulse {
  50% {
    border-color: #fff2cc;
  }
}
</style>
