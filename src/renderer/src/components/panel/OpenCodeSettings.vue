<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { OpenCodePasswordUnavailableReason, OpenCodeSettings } from '../../types'

/**
 * The OpenCode section of the Settings screen (#588 T6): the consent to the
 * permission relay, and the optional OpenCode server password.
 *
 * An UNSPECIFIED placement, like every section after Notifications:
 * `screens/settings.md` draws no OpenCode section, so this reuses the
 * vocabulary Notifications (one pressed/unpressed switch) and Jev (a masked
 * field with Save, Replace and Clear) already draw, and lands after Jev.
 *
 * The consent copy is product text and carries two facts on purpose. What
 * turning it on does — one file written into OpenCode's own configuration —
 * and the token coupling T3 found (D4): that file holds, in plain text, the
 * same per-install token the Claude hook route trusts, so reading it is
 * enough to forge Claude Code events to this app. It is said here, where the
 * person decides, not only in a code comment.
 *
 * Presentational: `settings` is main's verdict and every intent leaves as an
 * event. The typed password lives only in `draftPassword` until it is
 * submitted, exactly as JevSettings keeps its key.
 */
const props = defineProps<{
  /** Main's verdict — never what was last pressed. */
  settings: OpenCodeSettings
  /** True while a request this section made is in flight. */
  applying: boolean
}>()

const emit = defineEmits<{
  /** The relay should take this state. */
  'plugin-change': [enabled: boolean]
  /** Store this server password. */
  'password-save': [password: string]
  /** Forget the stored server password. */
  'password-clear': []
}>()

/** The password as typed so far. Never persisted anywhere by this component. */
const draftPassword = ref('')
/** Whether the field is shown to type a REPLACEMENT over a stored password. */
const replacing = ref(false)

const showingInput = computed(() => !props.settings.passwordConfigured || replacing.value)
// Not trimmed: spaces are part of a password (see parseOpenCodeServerPasswordInput).
const canSave = computed(() => !props.applying && draftPassword.value !== '')

function submit(): void {
  if (!canSave.value) return
  emit('password-save', draftPassword.value)
}

function startReplace(): void {
  draftPassword.value = ''
  replacing.value = true
}

function cancelReplace(): void {
  draftPassword.value = ''
  replacing.value = false
}

// Cleared only once main CONFIRMED the save, so a refused or broken save
// leaves the typed value where the person left it.
watch(
  () => props.applying,
  (applying, wasApplying) => {
    if (wasApplying && !applying && props.settings.passwordConfigured) {
      draftPassword.value = ''
      replacing.value = false
    }
  }
)

const UNAVAILABLE_MESSAGES: Record<OpenCodePasswordUnavailableReason, string> = {
  'encryption-unavailable':
    'This machine offers no encrypted place to keep a password, so one cannot be stored here.'
}

const unavailableMessage = computed(() => {
  const reason = props.settings.passwordUnavailableReason
  return reason === undefined ? '' : UNAVAILABLE_MESSAGES[reason]
})
</script>

<template>
  <section class="opencode-settings">
    <span class="field-label">OpenCode</span>

    <div class="switch-row">
      <button
        class="opencode-plugin-enabled"
        type="button"
        aria-label="Answer OpenCode permission requests from the panel"
        :aria-pressed="props.settings.pluginEnabled ? 'true' : 'false'"
        :disabled="props.applying"
        @click="emit('plugin-change', !props.settings.pluginEnabled)"
      >
        Permission requests
      </button>
    </div>

    <p class="hint consent">
      Turning this on writes one plugin file into OpenCode's own configuration folder, so a
      permission an OpenCode session asks for appears on its dwarf and can be answered from the
      panel. That file holds, in plain text, the same token this app uses to trust Claude Code's
      instant updates, so any program on this machine that can read it could also send this app
      false Claude Code session events.
    </p>

    <p v-if="props.settings.pluginError" class="plugin-error" role="alert">
      {{ props.settings.pluginError }}
    </p>

    <span class="row-label">Server password</span>
    <p v-if="unavailableMessage" class="password-unavailable">{{ unavailableMessage }}</p>
    <template v-else>
      <div v-if="!showingInput" class="password-stored-row">
        <span class="password-stored">Password stored</span>
        <button class="opencode-password-replace" type="button" @click="startReplace">
          Replace
        </button>
        <button
          class="opencode-password-clear"
          type="button"
          :disabled="props.applying"
          @click="emit('password-clear')"
        >
          Clear
        </button>
      </div>
      <div v-else class="password-row">
        <input
          class="opencode-password-input"
          type="password"
          autocomplete="off"
          spellcheck="false"
          aria-label="OpenCode server password"
          placeholder="Optional"
          :value="draftPassword"
          @input="draftPassword = ($event.target as HTMLInputElement).value"
          @keydown.enter="submit"
        />
        <button class="opencode-password-save" type="button" :disabled="!canSave" @click="submit">
          Save
        </button>
        <button
          v-if="props.settings.passwordConfigured"
          class="opencode-password-cancel"
          type="button"
          @click="cancelReplace"
        >
          Cancel
        </button>
      </div>
    </template>
    <p class="hint password-hint">
      Only needed if you start OpenCode with OPENCODE_SERVER_PASSWORD set; leave it empty otherwise,
      since OpenCode asks for no password by default. It is stored encrypted on this machine and
      sent only to the OpenCode server on this machine whose permission you answer.
    </p>
  </section>
</template>

<style scoped>
/* The Notifications and Jev sections' own layout, because this sits beside
   them and a different spacing rule would read as a different kind of section. */
.opencode-settings {
  display: flex;
  flex-direction: column;
  gap: var(--space-settings);
}
.field-label {
  padding-top: var(--space-settings);
  color: var(--color-cream);
  font-size: var(--text-section);
}
.row-label {
  color: var(--color-cream);
  font-size: var(--text-meta);
}
.switch-row,
.password-row,
.password-stored-row {
  display: flex;
  align-items: center;
  gap: var(--space-settings);
}
.password-stored {
  color: var(--color-accent);
  font-size: var(--text-meta);
}
.opencode-password-input {
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
/* The shared button model (components.md), identical to Notifications' switch
   and Jev's actions: pressed reads as an active control, unpressed fades to
   the deep background. */
.opencode-plugin-enabled,
.opencode-password-replace,
.opencode-password-clear,
.opencode-password-save,
.opencode-password-cancel {
  padding: 6px var(--space-settings);
  border: var(--border-active);
  border-radius: var(--radius-default);
  color: var(--color-cream);
  background: var(--color-control);
  font: inherit;
  font-size: var(--text-meta);
  cursor: pointer;
}
.opencode-plugin-enabled[aria-pressed='false'],
.opencode-plugin-enabled:disabled,
.opencode-password-save:disabled,
.opencode-password-clear:disabled {
  border: 2px solid var(--color-control-idle);
  color: var(--color-control-idle);
  background: var(--color-panel-deep);
}
.opencode-plugin-enabled:disabled,
.opencode-password-save:disabled,
.opencode-password-clear:disabled {
  cursor: default;
}
.opencode-plugin-enabled:focus-visible,
.opencode-password-replace:focus-visible,
.opencode-password-clear:focus-visible,
.opencode-password-save:focus-visible,
.opencode-password-cancel:focus-visible,
.opencode-password-input:focus-visible {
  outline: 2px solid var(--color-cream);
  outline-offset: 2px;
}
.hint,
.plugin-error,
.password-unavailable {
  margin: 0;
  color: var(--color-cream);
  font-size: var(--text-helper);
  line-height: 1.4;
}
</style>
