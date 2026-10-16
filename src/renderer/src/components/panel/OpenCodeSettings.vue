<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { OpenCodePasswordUnavailableReason, OpenCodeSettings } from '../../types'
import ActionButton from '../controls/ActionButton.vue'
import InputField from '../controls/InputField.vue'
import ToggleSwitch from '../controls/ToggleSwitch.vue'
import StatePill from '../dwarf/StatePill.vue'
import SettingsRow from './SettingsRow.vue'

/**
 * The OpenCode rows of Settings › Integrations (#588 T6, #635): the consent to
 * the permission relay, and the optional OpenCode server password, after the
 * Jev rows, as screens/settings.md orders them.
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
  <!--
    AMENDED (#635): the design's two rows (screens/settings.md, As built: "OpenCode · permission
    requests" with its switch, then Server password); every behaviour is today's.
  -->
  <SettingsRow
    class="opencode-settings"
    label="OpenCode · permission requests"
    stack
    help="Turning this on writes one plugin file into OpenCode’s own configuration folder, so a permission an OpenCode session asks for appears on its dwarf and can be answered from the panel. That file holds, in plain text, the same token this app uses to trust Claude Code’s instant updates, so any program on this machine that can read it could also send this app false Claude Code session events."
  >
    <template #notes>
      <p v-if="props.settings.pluginError" class="dm-srow__help plugin-error" role="alert">
        {{ props.settings.pluginError }}
      </p>
    </template>
    <ToggleSwitch
      class="opencode-plugin-enabled"
      label="Answer OpenCode permission requests from the panel"
      held
      :on="props.settings.pluginEnabled"
      :disabled="props.applying"
      @update:on="emit('plugin-change', $event)"
    />
  </SettingsRow>

  <SettingsRow
    class="opencode-password"
    label="Server password"
    stack
    help="Only needed if you start OpenCode with OPENCODE_SERVER_PASSWORD set; leave it empty otherwise, since OpenCode asks for no password by default. It is stored encrypted on this machine and sent only to the OpenCode server on this machine whose permission you answer."
  >
    <template #notes>
      <p v-if="unavailableMessage" class="dm-srow__help password-unavailable">
        {{ unavailableMessage }}
      </p>
    </template>
    <span
      v-if="!unavailableMessage && !showingInput"
      class="dm-settings__inline password-stored-row"
    >
      <StatePill class="password-stored" text="Password stored" tone="ok" icon="check" />
      <ActionButton class="opencode-password-replace" label="Replace" @click="startReplace" />
      <ActionButton
        class="opencode-password-clear"
        label="Clear"
        :disabled="props.applying"
        @click="emit('password-clear')"
      />
    </span>
    <span v-else-if="!unavailableMessage" class="dm-settings__inline password-row">
      <InputField
        class="opencode-password-input"
        type="password"
        label="OpenCode server password"
        placeholder="Optional"
        :value="draftPassword"
        @update:value="draftPassword = $event"
        @keydown.enter="submit"
      />
      <ActionButton
        class="opencode-password-save"
        label="Save"
        variant="primary"
        :disabled="!canSave"
        @click="submit"
      />
      <ActionButton
        v-if="props.settings.passwordConfigured"
        class="opencode-password-cancel"
        label="Cancel"
        @click="cancelReplace"
      />
    </span>
  </SettingsRow>
</template>

<style scoped>
/* The design's settings.css `.dm-settings__inline`. */
.dm-settings__inline {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.dm-srow__help.plugin-error {
  color: var(--danger-hi);
}
</style>
