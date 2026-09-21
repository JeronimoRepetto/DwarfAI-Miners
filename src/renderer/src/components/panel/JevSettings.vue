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
 * Display names for the default-launch provider select (#509 follow-up) —
 * mirrors `launchProviders.ts`'s own `PRODUCT_NAME` table, copied rather than
 * imported: main/ and renderer/ never cross in production code (AGENTS.md),
 * and this is copy a person reads, not a value read for capability.
 */
const PRODUCT_NAME: Record<DwarfProvider, string> = {
  claude: 'Claude Code',
  codex: 'Codex CLI',
  antigravity: 'Antigravity CLI',
  opencode: 'OpenCode'
}

/** Only a provider a launch could actually start with belongs in this picker. */
const launchableProviders = computed(() => props.providers.filter((entry) => entry.launchable))

const defaultProvider = computed(() => preferences.value.default.provider)

// Reused from the launch surface (#239) rather than reinvented: the same
// catalogue answers both the Add Panel's contextual row and this stored one.
const defaultModelPicker = computed(() =>
  modelPicker(props.catalogs, defaultProvider.value ?? null)
)
const defaultEffortPicker = computed(() =>
  effortPicker(props.catalogs, defaultProvider.value ?? null)
)

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

      <div v-if="props.settings.configured" class="jev-profile">
        <span class="row-label">Routing profile</span>
        <div class="segments">
          <button
            v-for="profile in JEV_ROUTING_PROFILES"
            :key="profile"
            class="profile-option"
            type="button"
            :class="{ 'is-selected': preferences.profile === profile }"
            :aria-pressed="preferences.profile === profile ? 'true' : 'false'"
            :disabled="props.saving"
            @click="selectProfile(profile)"
          >
            <span class="profile-name">{{ PROFILE_LABEL[profile] }}</span>
            <span class="profile-description">{{ PROFILE_DESCRIPTION[profile] }}</span>
          </button>
        </div>
      </div>

      <div v-if="props.settings.configured" class="jev-default-launch">
        <span class="row-label">Default launch</span>
        <div class="default-launch-row">
          <select
            class="tuning-select"
            aria-label="Default provider"
            :value="defaultProvider ?? ''"
            :disabled="props.saving"
            @change="selectDefaultProvider(($event.target as HTMLSelectElement).value)"
          >
            <option value="">None</option>
            <option
              v-for="entry in launchableProviders"
              :key="entry.provider"
              :value="entry.provider"
            >
              {{ PRODUCT_NAME[entry.provider] }}
            </option>
          </select>
          <select
            class="tuning-select"
            aria-label="Default model"
            :value="preferences.default.model ?? ''"
            :disabled="modelSelectDisabled"
            @change="selectDefaultModel(($event.target as HTMLSelectElement).value)"
          >
            <option value="">CLI default</option>
            <option
              v-for="option in defaultModelPicker.models"
              :key="option.value"
              :value="option.value"
            >
              {{ option.label ?? option.value }}
            </option>
          </select>
          <select
            class="tuning-select"
            aria-label="Default effort"
            :value="preferences.default.effort ?? ''"
            :disabled="effortSelectDisabled"
            @change="selectDefaultEffort(($event.target as HTMLSelectElement).value)"
          >
            <option value="">CLI default</option>
            <option v-for="level in defaultEffortPicker.efforts" :key="level" :value="level">
              {{ level }}
            </option>
          </select>
        </div>
        <p class="hint">Used when Jev cannot decide.</p>
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
  border: 2px solid var(--color-control-disabled);
  color: var(--color-control-disabled);
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

/* The routing profile (#509 follow-up): TypographySettings' own row-label +
   segments model, because this is the same kind of mutually-exclusive choice
   — reused rather than reinvented, down to the class names. */
.jev-profile,
.jev-default-launch {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.row-label {
  color: var(--color-cream);
  font-size: var(--text-meta);
}
.segments {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-settings);
}
.profile-option {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px var(--space-settings);
  border: 2px solid var(--color-control-idle);
  border-radius: var(--radius-default);
  color: var(--color-control-idle);
  cursor: pointer;
  background: var(--color-panel-deep);
  font: inherit;
  text-align: left;
}
.profile-option.is-selected {
  border: var(--border-active);
  color: var(--color-cream);
  background: var(--color-control);
}
.profile-option:disabled {
  cursor: default;
}
.profile-option:focus-visible {
  outline: 2px solid var(--color-cream);
  outline-offset: 2px;
}
.profile-name {
  font-size: var(--text-meta);
}
.profile-description {
  font-size: var(--text-helper);
  line-height: 1.4;
}

/* The default-launch row: AddPanel's own `.tuning-select` (launch.md),
   because the model and effort pickers ARE that row's controls, reused for a
   stored default instead of a live composer. */
.default-launch-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-settings);
}
.tuning-select {
  flex: 1 1 auto;
  min-width: 0;
  padding: 6px var(--space-settings);
  border: var(--border-active);
  border-radius: var(--radius-default);
  color: var(--color-cream);
  background: var(--color-panel-deep);
  font: inherit;
  font-size: var(--text-meta);
}
.tuning-select:disabled {
  border: 2px solid var(--color-control-disabled);
  color: var(--color-control-disabled);
  cursor: default;
}
.tuning-select:focus-visible {
  outline: 2px solid var(--color-cream);
  outline-offset: 2px;
}
</style>
