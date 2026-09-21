<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { JevSettings, JevUnavailableReason } from '../../types'

/**
 * The Jev section of the Settings screen (#509): the TypeSafe API key a
 * person enters, replaces and clears themselves — this app never ships or
 * generates one — plus the privacy notice the new outbound call requires.
 *
 * The key never reaches a store or a wire from here. It lives only in
 * `draftKey`, this component's own local state, for as long as it takes to
 * submit it; App.vue hands the typed value straight to the preload, which
 * hands it straight to main, and nothing along that path is retained past the
 * request except by `jevApiKey.ts`'s encrypted file. Presentational like
 * every other settings piece: `settings` is main's verdict, never a wish, and
 * every intent leaves as an event — `save`/`clear` — so App.vue keeps owning
 * the IPC and the "render only what main verified" rule stays in one place.
 *
 * `replacing` is the other piece of local display state: whether the input is
 * shown OVER an already-configured key. Nothing outside this screen needs
 * either local ref, the same reason ResetMetricsModal's open/closed flag
 * stays in SettingsPanel rather than crossing a prop.
 */
const props = defineProps<{
  /** Whether a key is configured, and why it might never be — main's verdict. */
  settings: JevSettings
  /** True while a save or a clear this section asked for is in flight. */
  saving: boolean
}>()

const emit = defineEmits<{
  /** Enter or replace the key with this one. */
  save: [key: string]
  /** Forget the stored key. */
  clear: []
}>()

/** The unsaved key as typed so far. Never persisted anywhere by this component. */
const draftKey = ref('')
/** Whether the input is shown to type a REPLACEMENT over an already-configured key. */
const replacing = ref(false)

const canSave = computed(() => !props.saving && draftKey.value.trim() !== '')
/** The input (and the Save/Cancel row around it) is shown until a key is configured. */
const showingInput = computed(() => !props.settings.configured || replacing.value)

function submit(): void {
  if (!canSave.value) return
  emit('save', draftKey.value)
}

function startReplace(): void {
  draftKey.value = ''
  replacing.value = true
}

function cancelReplace(): void {
  draftKey.value = ''
  replacing.value = false
}

// Cleared only once main has actually CONFIRMED the save — a save still in
// flight, or one that came back refused, must leave the typed key exactly
// where the person left it, so a hiccup does not cost them a retype.
watch(
  () => props.saving,
  (saving, wasSaving) => {
    if (wasSaving && !saving && props.settings.configured) {
      draftKey.value = ''
      replacing.value = false
    }
  }
)

/**
 * Prose for each reason this control can be unavailable — kept here rather
 * than on the wire, the same split every other prompt-sentence-that-names-no-
 * provider holds in `contracts.ts`: `unavailableReason` is the fact main
 * proved, and its wording is display text only the renderer owns.
 */
const UNAVAILABLE_MESSAGES: Record<JevUnavailableReason, string> = {
  'encryption-unavailable':
    'This machine offers no encrypted place to keep a key, so Jev cannot be turned on here.'
}

const unavailableMessage = computed(() => {
  const reason = props.settings.unavailableReason
  return reason === undefined ? '' : UNAVAILABLE_MESSAGES[reason]
})
</script>

<template>
  <section class="jev-settings">
    <span class="field-label">Jev</span>

    <p v-if="unavailableMessage" class="jev-unavailable">{{ unavailableMessage }}</p>

    <template v-else>
      <div v-if="!showingInput" class="jev-configured-row">
        <span class="jev-configured">Configured</span>
        <button class="jev-replace" type="button" @click="startReplace">Replace</button>
        <button class="jev-clear" type="button" @click="emit('clear')">Clear</button>
      </div>

      <div v-else class="jev-key-row">
        <input
          class="jev-key-input"
          type="password"
          autocomplete="off"
          spellcheck="false"
          aria-label="TypeSafe API key"
          placeholder="Paste your TypeSafe API key"
          :value="draftKey"
          @input="draftKey = ($event.target as HTMLInputElement).value"
          @keydown.enter="submit"
        />
        <button class="jev-save" type="button" :disabled="!canSave" @click="submit">Save</button>
        <button
          v-if="props.settings.configured"
          class="jev-cancel-replace"
          type="button"
          @click="cancelReplace"
        >
          Cancel
        </button>
      </div>
    </template>

    <p class="hint privacy-notice">
      With Jev on, the prompt text and the list of providers and models this machine can launch are
      sent to TypeSafe's API (api.typesafe.ai) when a session starts, so it can choose one for you.
      The key is stored encrypted on this machine and is sent only to TypeSafe, to authenticate that
      request.
    </p>
  </section>
</template>

<style scoped>
/* The Audio and Notifications sections' own layout, because this sits beside
   them and a third spacing rule would read as a different kind of section. */
.jev-settings {
  display: flex;
  flex-direction: column;
  gap: var(--space-settings);
}
.field-label {
  padding-top: var(--space-settings);
  color: var(--color-cream);
  font-size: var(--text-section);
}
.jev-configured-row,
.jev-key-row {
  display: flex;
  align-items: center;
  gap: var(--space-settings);
}
.jev-configured {
  color: var(--color-accent);
  font-size: var(--text-meta);
}
.jev-key-input {
  flex: 1;
  min-width: 0;
  padding: 6px var(--space-settings);
  border: var(--border-active);
  border-radius: var(--radius-default);
  color: var(--color-cream);
  background: var(--color-panel-deep);
  font: inherit;
  font-size: var(--text-meta);
}
/* The shared button model (components.md), identical to Audio's and
   Notifications' own controls: an active, pressable rectangle rather than a
   second visual language for this section's actions. */
.jev-replace,
.jev-clear,
.jev-save,
.jev-cancel-replace {
  padding: 6px var(--space-settings);
  border: var(--border-active);
  border-radius: var(--radius-default);
  color: var(--color-cream);
  background: var(--color-control);
  font: inherit;
  font-size: var(--text-meta);
  cursor: pointer;
}
.jev-save:disabled {
  border: 2px solid var(--color-control);
  color: var(--color-control);
  background: var(--color-panel-deep);
  cursor: default;
}
.jev-key-input:focus-visible,
.jev-replace:focus-visible,
.jev-clear:focus-visible,
.jev-save:focus-visible,
.jev-cancel-replace:focus-visible {
  outline: 2px solid var(--color-cream);
  outline-offset: 2px;
}
.jev-unavailable,
.hint {
  margin: 0;
  color: var(--color-cream);
  font-size: var(--text-helper);
  line-height: 1.4;
}
</style>
