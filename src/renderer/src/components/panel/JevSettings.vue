<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type {
  AgentModelCatalog,
  AgentProviderOption,
  DwarfProvider,
  JevLaunchDefault,
  JevPreferences,
  JevRoutingProfile,
  JevSettings,
  JevUnavailableReason
} from '../../types'
import { DEFAULT_JEV_PREFERENCES, JEV_ROUTING_PROFILES } from '../../types'
import { effortPicker, modelPicker } from '../../lib/launch/modelTuning'
import { providerLabel } from '../../lib/dwarf/dwarfTip'
import ActionButton from '../controls/ActionButton.vue'
import ChoiceChip from '../controls/ChoiceChip.vue'
import InputField from '../controls/InputField.vue'
import SelectField from '../controls/SelectField.vue'
import ToggleSwitch from '../controls/ToggleSwitch.vue'
import StatePill from '../dwarf/StatePill.vue'
import SegmentedChoice from './SegmentedChoice.vue'
import SettingsRow from './SettingsRow.vue'

/**
 * The Jev rows of Settings › Integrations (#509, #635): the TypeSafe API key a
 * person enters, replaces and clears themselves — this app never ships or
 * generates one. The privacy notice the outbound call requires stands at the
 * foot of the section, in JevPrivacyNotice (#635).
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
 * either local ref, the same reason the reset dialog's open flag
 * stays in SettingsPanel rather than crossing a prop.
 *
 * AMENDED for the #509 follow-up: below the key controls, once `configured`
 * is true, two more controls read and write `settings.preferences` — the
 * routing profile and the default launch. Both are PURE presentational
 * pickers, exactly like the key row above: every choice leaves as one
 * `preferences-change` event carrying the WHOLE document (never a patch —
 * `default`'s three fields are too entangled for a patch to merge safely,
 * unlike TypographySettings' two independent rows), and nothing here is ever
 * redrawn from a local draft. `providers`/`catalogs` are asked by
 * `useJevSettings` the same way the launch surface asks them, reused here
 * through `modelTuning.ts` rather than reinvented.
 */
const props = defineProps<{
  /** Whether a key is configured, and why it might never be — main's verdict. */
  settings: JevSettings
  /** True while a save or a clear this section asked for is in flight. */
  saving: boolean
  /** Every known provider's availability (#509 follow-up) — for the default-launch picker. */
  providers: AgentProviderOption[]
  /** What each provider can start on (#509 follow-up) — for the model/effort pickers. */
  catalogs: AgentModelCatalog[]
}>()

const emit = defineEmits<{
  /** Enter or replace the key with this one. */
  save: [key: string]
  /** Forget the stored key. */
  clear: []
  /** The routing profile and/or the default launch should become this whole document. */
  'preferences-change': [preferences: JevPreferences]
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

/**
 * A stale mock or a main that has not answered fully may omit `preferences`
 * even though the wire type now requires it — degrade to the documented
 * default exactly like every other stored preference here, rather than
 * crash the one section that still has a real key to show.
 */
const preferences = computed<JevPreferences>(
  () => props.settings.preferences ?? DEFAULT_JEV_PREFERENCES
)

const PROFILE_LABEL: Record<JevRoutingProfile, string> = {
  economy: 'Economy',
  balanced: 'Balanced',
  premium: 'Premium'
}

/** One line each, the user's own words (2026-09-21). */
const PROFILE_DESCRIPTION: Record<JevRoutingProfile, string> = {
  economy: 'Cheapest model that can do the job',
  balanced: 'Cost and capability weighed per prompt',
  premium: 'Most capable model when the task warrants it; trivial prompts still go cheap'
}

/**
 * The Routing profile row's help (#635): each profile's one line after its name, in order, as the
 * design's row prints them.
 */
const PROFILE_HELP = JEV_ROUTING_PROFILES.map((profile) => {
  const line = PROFILE_DESCRIPTION[profile]
  return PROFILE_LABEL[profile] + ': ' + line.charAt(0).toLowerCase() + line.slice(1) + '.'
}).join(' ')

/*
 * AMENDED (#635): the default-launch provider select names each tool as people know it
 * ("Claude", "Codex"), the design's own words (screens/settings.md: "Default provider shows
 * Claude"), from the table the dwarf tooltip reads — no longer the product names copied from
 * launchProviders.ts.
 */
const providerOptions = computed(() => [
  { value: '', label: 'None' },
  ...props.providers
    .filter((entry) => entry.launchable)
    .map((entry) => ({ value: entry.provider, label: providerLabel(entry.provider) }))
])

/* Only a provider a launch could actually start with belongs in the picker above. */

const defaultProvider = computed(() => preferences.value.default.provider)

// Reused from the launch surface (#239) rather than reinvented: the same
// catalogue answers both the Add Panel's contextual row and this stored one.
const defaultModelPicker = computed(() =>
  modelPicker(props.catalogs, defaultProvider.value ?? null)
)
const defaultEffortPicker = computed(() =>
  effortPicker(props.catalogs, defaultProvider.value ?? null)
)

/** "CLI default" first, then the provider's own models, as the launch surface lists them. */
const modelOptions = computed(() => [
  { value: '', label: 'CLI default' },
  ...defaultModelPicker.value.models.map((option) => ({
    value: option.value,
    label: option.label ?? option.value
  }))
])
const effortOptions = computed(() => [
  { value: '', label: 'CLI default' },
  ...defaultEffortPicker.value.efforts.map((level) => ({ value: level, label: level }))
])

/** No provider chosen means nothing here CAN be validated against a ladder or CLI yet. */
const modelSelectDisabled = computed(
  () => props.saving || defaultProvider.value === undefined || defaultModelPicker.value.disabled
)
const effortSelectDisabled = computed(
  () =>
    props.saving ||
    defaultProvider.value === undefined ||
    defaultEffortPicker.value.efforts.length === 0
)

function selectProfile(profile: JevRoutingProfile): void {
  emit('preferences-change', { ...preferences.value, profile })
}

/**
 * A new provider clears model and effort (#509 follow-up): both belonged to
 * the OLD provider's own ladder and catalogue, and carrying them over risks
 * a pairing the new provider's launch gate would refuse outright — the same
 * reason `jevPreferences.ts`'s `save` re-validates the pair at all.
 */
function selectDefaultProvider(value: string): void {
  const nextDefault: JevLaunchDefault = value === '' ? {} : { provider: value as DwarfProvider }
  emit('preferences-change', { ...preferences.value, default: nextDefault })
}

function selectDefaultModel(value: string): void {
  const nextDefault: JevLaunchDefault = { ...preferences.value.default }
  if (value === '') {
    delete nextDefault.model
  } else {
    nextDefault.model = value
  }
  emit('preferences-change', { ...preferences.value, default: nextDefault })
}

function selectDefaultEffort(value: string): void {
  const nextDefault: JevLaunchDefault = { ...preferences.value.default }
  if (value === '') {
    delete nextDefault.effort
  } else {
    nextDefault.effort = value
  }
  emit('preferences-change', { ...preferences.value, default: nextDefault })
}

/**
 * The MCP subtask-delegation checkbox (#511) — gate level (2) of the three
 * `delegationGate.ts` requires. Off by default, and drawn exactly like the
 * profile and default-launch controls above: key-gated, whole-document
 * `preferences-change`, nothing local to redraw from.
 */
function toggleDelegation(checked: boolean): void {
  emit('preferences-change', { ...preferences.value, delegation: checked })
}
</script>

<template>
  <!--
    AMENDED (#635): the rows are the design's (screens/settings.md, As built: Integrations, in
    order — the Jev row, Routing profile, Default launch, Subagent delegation · beta); every
    behaviour below is today's, only drawn with the design's row and controls.
  -->
  <SettingsRow
    class="jev-settings"
    label="Jev"
    stack
    help="Your TypeSafe API key. Jev routes each new dwarf to a supplier, model and effort."
  >
    <template #notes>
      <p v-if="unavailableMessage" class="dm-srow__help jev-unavailable">
        {{ unavailableMessage }}
      </p>
    </template>
    <span
      v-if="!unavailableMessage && !showingInput"
      class="dm-settings__inline jev-configured-row"
    >
      <StatePill class="jev-configured" text="Configured" tone="ok" icon="check" />
      <ActionButton class="jev-replace" label="Replace" @click="startReplace" />
      <ActionButton class="jev-clear" label="Clear" @click="emit('clear')" />
    </span>
    <span v-else-if="!unavailableMessage" class="dm-settings__inline jev-key-row">
      <InputField
        class="jev-key-input"
        type="password"
        label="TypeSafe API key"
        placeholder="Paste your TypeSafe API key"
        :value="draftKey"
        @update:value="draftKey = $event"
        @keydown.enter="submit"
      />
      <ActionButton
        class="jev-save"
        label="Save"
        variant="primary"
        :disabled="!canSave"
        @click="submit"
      />
      <ActionButton
        v-if="props.settings.configured"
        class="jev-cancel-replace"
        label="Cancel"
        @click="cancelReplace"
      />
    </span>
  </SettingsRow>

  <template v-if="!unavailableMessage && props.settings.configured">
    <SettingsRow class="jev-profile" label="Routing profile" stack :help="PROFILE_HELP">
      <template #notes>
        <!--
          Why the last preference write did not take. Absent when it did.

          `role="alert"`, because nothing else on screen moved: the mark stays on the profile
          actually in force, which is the honest drawing and also the reason a failure is
          invisible without this line.
        -->
        <p
          v-if="props.settings.preferencesError"
          class="dm-srow__help preferences-error"
          role="alert"
        >
          {{ props.settings.preferencesError }}
        </p>
      </template>
      <SegmentedChoice>
        <ChoiceChip
          v-for="profile in JEV_ROUTING_PROFILES"
          :key="profile"
          class="profile-option"
          role="radio"
          :data-value="PROFILE_LABEL[profile]"
          :label="PROFILE_LABEL[profile]"
          :pressed="preferences.profile === profile"
          :disabled="props.saving"
          @click="selectProfile(profile)"
        />
      </SegmentedChoice>
    </SettingsRow>

    <SettingsRow
      class="jev-default-launch"
      label="Default launch"
      stack
      help="Used when Jev cannot decide."
    >
      <SelectField
        held
        class="tuning-select provider-select"
        label="Default provider"
        :value="defaultProvider ?? ''"
        :options="providerOptions"
        :disabled="props.saving"
        @update:value="selectDefaultProvider"
      />
      <span class="dm-settings__slot">
        <SelectField
          held
          class="tuning-select model-select"
          label="Default model"
          :value="preferences.default.model ?? ''"
          :options="modelOptions"
          :disabled="modelSelectDisabled"
          @update:value="selectDefaultModel"
        />
      </span>
      <span class="dm-settings__slot">
        <SelectField
          held
          class="tuning-select effort-select"
          label="Default effort"
          :value="preferences.default.effort ?? ''"
          :options="effortOptions"
          :disabled="effortSelectDisabled"
          @update:value="selectDefaultEffort"
        />
      </span>
    </SettingsRow>

    <SettingsRow
      class="jev-delegation"
      label="Subagent delegation · beta"
      tone="danger"
      help="Let Jev choose subagents by subtask complexity. A launched session may hand a subtask back through Jev, so a bigger job can be split across cheaper models instead of running entirely on the one you started."
    >
      <ToggleSwitch
        class="delegation-toggle"
        label="Let Jev choose subagents by subtask complexity"
        held
        :on="preferences.delegation"
        :disabled="props.saving"
        @update:on="toggleDelegation"
      />
    </SettingsRow>
  </template>
</template>

<style scoped>
/* The design's settings.css `.dm-settings__inline` and `.dm-settings__slot`. */
.dm-settings__inline {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.dm-settings__slot {
  display: inline-flex;
}
.dm-srow__help.preferences-error {
  color: var(--danger-hi);
}
</style>
