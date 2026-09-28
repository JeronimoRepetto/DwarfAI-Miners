<script setup lang="ts">
import { computed, onMounted, ref, useId } from 'vue'
import { DEFAULT_TOGGLE_ACCELERATOR, formatAccelerator } from '../../../../shared/accelerator'
import type { ShortcutState } from '../../types'
import ActionButton from '../controls/ActionButton.vue'
import KeyCap from './KeyCap.vue'
import SettingsRow from './SettingsRow.vue'

/**
 * The Panel shortcut row of Settings › General (#138, #635, screens/settings.md) — the global
 * panel-toggle shortcut, with a recorder that listens for a key combination.
 *
 * **The shortcut does not change** (W6): the redesign only restyles this row. Recording,
 * validation, the per-platform key names, the default and the unavailable state all work exactly
 * as they did; the recorder is now drawn as the design's sunken key cap (KeyCap, as a real
 * button) beside Reset to default, the hint is the row's help line, and a refused chord is an
 * alert under it. The capture logic below is unchanged.
 *
 * The Escape-to-close keydown handler stays: it is still a reasonable way out of a listening
 * recorder, and ShortcutSettings.test.ts still pins it. There is no dialog role and no close
 * button of its own: leaving Settings is selecting another nav area.
 *
 * Presentational on purpose: every piece of state arrives as a prop and every intent leaves as an
 * event. App.vue owns useToggleShortcut and therefore owns the IPC. That is what lets this
 * component be tested without a window.api stub, and it keeps the "only render what main verified"
 * rule in exactly one place.
 */

const props = withDefaults(
  defineProps<{
    /** The verified state from main, or null while it is still being read. */
    state: ShortcutState | null
    /** Why the last attempt failed — from main, or from a locally refused chord. */
    error: string | null
    recording: boolean
    applying: boolean
    /**
     * Whether mounting moves the focus to the recorder. On when Settings opens on this row;
     * Settings turns it off when a keyboard user arrives here from the section tabs, whose focus
     * must stay on the tab.
     */
    autofocus?: boolean
  }>(),
  { autofocus: true }
)

const emit = defineEmits<{
  'start-recording': []
  'stop-recording': []
  /** One keydown captured by the recorder; the owner translates and applies it. */
  record: [event: KeyboardEvent]
  reset: []
  close: []
}>()

// Generated rather than hardcoded: the panel is a singleton today, but a fixed id turns into a
// silent accessibility bug the moment that stops being true.
const valueId = useId()
const hintId = useId()

const recorderRef = ref<InstanceType<typeof KeyCap> | null>(null)

/** Nothing is operable until the real state has arrived, or while it is changing. */
const busy = computed(() => props.applying || props.state === null)

const recorderText = computed(() => {
  if (props.recording) return 'Press a combination...'
  if (props.state === null) return 'Checking...'
  // The wire spelling ('Control+Alt+Shift+P') is never shown to a human.
  return formatAccelerator(props.state.accelerator, props.state.platform)
})

/**
 * The one line that must never lie: a combination the OS refused is reported as unavailable,
 * never as active, however tidy the key cap beside it looks.
 */
const hint = computed(() => {
  if (props.recording) return 'Listening - press a combination, or Escape to cancel.'
  if (props.state === null) return 'Reading the current shortcut...'
  if (props.applying) return 'Applying...'
  if (!props.state.registered) {
    return 'Unavailable - another application owns this combination. Click to record a different one.'
  }
  // Exact copy from screens/settings.md — not "the panel" as the interim overlay had it.
  return 'Active - press it anywhere to show or hide panel.'
})

/**
 * Resetting is only pointless when the default is BOTH selected and working: with a failed
 * registration the same click is how the user retries, once whatever owned the combination has
 * quit.
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
  // While listening the recorder consumes the keystroke completely, so Escape cancels the
  // recording WITHOUT also reaching the row's own close handler — changing your mind about a
  // chord must not cost you the panel.
  if (props.recording) event.stopPropagation()
  emit('record', event)
}

// A keyboard user opening settings lands directly on the control they came for.
onMounted(() => {
  if (props.autofocus) (recorderRef.value?.$el as HTMLElement | undefined)?.focus()
})
</script>

<template>
  <SettingsRow label="Panel shortcut" stack @keydown.escape="emit('close')">
    <template #notes>
      <p :id="hintId" class="dm-srow__help hint" role="status">{{ hint }}</p>
      <p v-if="error" class="dm-srow__help settings-error" role="alert">{{ error }}</p>
    </template>
    <template #default="{ labelId }">
      <!--
      The accessible name is the row's label plus the current value, so a screen reader announces
      "Panel shortcut, Ctrl + Alt + Shift + P" rather than a bare combination; aria-pressed carries
      the listening state and the hint is wired up as the description.
    -->
      <KeyCap
        ref="recorderRef"
        button
        class="recorder"
        :class="{ 'is-recording': recording, 'is-broken': state !== null && !state.registered }"
        :disabled="busy"
        :aria-pressed="recording ? 'true' : 'false'"
        :aria-labelledby="`${labelId} ${valueId}`"
        :aria-describedby="hintId"
        @click="onRecorderClick"
        @keydown="onRecorderKeydown"
      >
        <span :id="valueId">{{ recorderText }}</span>
      </KeyCap>
      <ActionButton
        class="reset"
        label="Reset to default"
        :disabled="resetDisabled"
        @click="emit('reset')"
      />
    </template>
  </SettingsRow>
</template>

<style scoped>
/* A refused chord reads in the light danger ink, the one colour the design gives danger text on a
   dark ground (foundations.md); the row's help colour is for the hint alone. */
.dm-srow__help.settings-error {
  color: var(--danger-hi);
}
</style>
