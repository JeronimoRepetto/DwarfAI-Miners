<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue'
import { formatAccelerator } from '../../../../shared/accelerator'
import type {
  AgentModelCatalog,
  AgentProviderOption,
  AudioPreferences,
  JevPreferences,
  JevSettings as JevSettingsType,
  OpenCodeSettings as OpenCodeSettingsType,
  PanelEdge,
  ShortcutState,
  TypographyPreferences
} from '../../types'
import {
  SETTINGS_SECTIONS,
  steppedSection,
  type SettingsSection
} from '../../lib/settings/sections'
import type { DialogAction } from '../../lib/overlay/dialog'
import ActionButton from '../controls/ActionButton.vue'
import ToggleSwitch from '../controls/ToggleSwitch.vue'
import ModalDialog from '../overlay/ModalDialog.vue'
import PageHeader from '../shell/PageHeader.vue'
import AudioSettings from './AudioSettings.vue'
import DataBaseSection from './DataBaseSection.vue'
import JevPrivacyNotice from './JevPrivacyNotice.vue'
import JevSettings from './JevSettings.vue'
import NotificationSettings from './NotificationSettings.vue'
import OpenCodeSettings from './OpenCodeSettings.vue'
import PositionSettings from './PositionSettings.vue'
import SettingsBanner from './SettingsBanner.vue'
import SettingsRow from './SettingsRow.vue'
import ShortcutSettings from './ShortcutSettings.vue'
import TypographySettings from './TypographySettings.vue'

/**
 * The Settings page (#138, #635), `organisms/settings` in the design: the page header, then seven
 * sections in place of one long scroll (screens/settings.md, W6) — a vertical tablist on the left,
 * moved with ↑ and ↓, and the chosen section's rows on the right.
 *
 * - General: the shortcut failure's banner when the panel shortcut did not register, then
 *   Position, the Panel shortcut and Always on top. The design's "Mode at launch" row is not
 *   drawn: the app has one mode until Veta and Valle land, and a choice of modes that do not exist
 *   is a control that lies (PR5 question) — the nav's mode lever is hidden for the same reason.
 * - Appearance: the Font style list and Custom's rows. Sound: music at startup and the three
 *   volumes. Notifications: the one switch. Integrations: Jev, then OpenCode. Data: Reset
 *   metrics…, in the danger zone, confirmed by typing "yes" in the dialog. About: the version and
 *   Hide panel.
 *
 * A failed shortcut also puts a warning dot on the General tab. Every row's label, help and
 * behaviour is the section component's own, copied from what it did before (handoff.md,
 * Component mapping: "Re-frames; every label and help string stays the component's own").
 *
 * Presentational, like every settings piece: every verdict arrives as a prop and every intent
 * leaves as an event, so App.vue keeps owning the IPC (the shortcut, the panel layout, the pin, the
 * reset, every stored preference) and the "render only what main verified" rule stays in exactly
 * one place. Kept LOCAL here: which section is shown, and whether the reset dialog is open —
 * display state nothing outside this page ever needs to read.
 */
const props = withDefaults(
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
    /** What Settings' Sound section has stored (#174, #173) — main's verdict. */
    audioSettings: AudioPreferences
    /** Whether the OS notification centre may be used — main's verdict, not a wish. */
    notificationsEnabled: boolean
    /** The font style and its faces — main's verdict. */
    typography: TypographyPreferences
    /** True while a font change is in flight; locks the Appearance rows. */
    typographyApplying: boolean
    /** Whether a TypeSafe key is configured, and why it might never be — main's verdict. */
    jevSettings: JevSettingsType
    /** True while a save or a clear the Jev rows asked for is in flight. */
    jevSaving: boolean
    /** Every known provider's availability — for the default-launch picker. */
    jevProviders: AgentProviderOption[]
    /** What each provider can start on — for the default-launch model/effort pickers. */
    jevCatalogs: AgentModelCatalog[]
    /** The relay consent and whether a server password is stored — main's verdict. */
    openCodeSettings: OpenCodeSettingsType
    /** True while a request the OpenCode rows made is in flight. */
    openCodeApplying: boolean
    /** The section shown when the page opens; General unless a caller asks for another. */
    section?: SettingsSection
  }>(),
  { section: 'General' }
)

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
  /** One field of the Sound settings should change (#174). */
  'audio-change': [patch: Partial<AudioPreferences>]
  /** The notifications switch should take this value (#316). */
  'notifications-change': [enabled: boolean]
  /** The font style should become this whole choice (#370, #635). */
  'typography-change': [preferences: TypographyPreferences]
  /** Enter or replace the TypeSafe key with this one. */
  'jev-save': [key: string]
  /** Forget the stored key. */
  'jev-clear': []
  /** The routing profile and/or the default launch should become this whole document. */
  'jev-preferences-change': [preferences: JevPreferences]
  /** The OpenCode permission relay should take this state. */
  'opencode-plugin-change': [enabled: boolean]
  /** Store this OpenCode server password. */
  'opencode-password-save': [password: string]
  /** Forget the stored OpenCode server password. */
  'opencode-password-clear': []
}>()

const shown = ref<SettingsSection>(props.section)
// The recorder takes the focus when Settings opens on General, not when a keyboard user walks
// back to General through the tabs: the tab keeps the focus the arrow gave it.
const recorderFocus = ref(true)
const tabIds = Object.fromEntries(SETTINGS_SECTIONS.map((s) => [s, useId()])) as Record<
  SettingsSection,
  string
>
const panelId = useId()
const nav = ref<HTMLElement | null>(null)
const panel = ref<HTMLElement | null>(null)

/** The shortcut the OS refused, as this keyboard names it; null while it works or is unread. */
const brokenShortcut = computed(() =>
  props.shortcutState !== null && !props.shortcutState.registered
    ? formatAccelerator(props.shortcutState.accelerator, props.shortcutState.platform)
    : null
)

function show(section: SettingsSection): void {
  recorderFocus.value = false
  shown.value = section
  if (panel.value) panel.value.scrollTop = 0
}

async function step(event: KeyboardEvent): Promise<void> {
  const next = steppedSection(shown.value, event.key)
  if (next === undefined) return
  event.preventDefault()
  show(next)
  await nextTick()
  nav.value?.querySelector<HTMLElement>(`[data-s="${next}"]`)?.focus()
}

/* --- Reset metrics: the typed confirmation (molecules/dialog) ----------------------------------- */
const resetOpen = ref(false)
const resetActions = computed<DialogAction[]>(() => [
  { label: 'Cancel' },
  { label: 'Reset metrics', variant: 'danger', confirms: true, disabled: props.resetting }
])

function resetAction(index: number): void {
  if (index === 1) emit('reset-confirm')
  else resetOpen.value = false
}

// A reset that went through closes its dialog, as the design's confirmation does; one that did
// not stays open with its reason, so the person can try again or cancel.
watch(
  () => props.resetting,
  (resetting, was) => {
    if (was && !resetting && props.resetError === null) resetOpen.value = false
  }
)
</script>

<template>
  <section class="dm-settings" aria-label="Settings">
    <PageHeader title="Settings" />
    <div class="dm-settings__body">
      <div
        ref="nav"
        class="dm-settings__nav"
        role="tablist"
        aria-orientation="vertical"
        aria-label="Settings sections"
        @keydown="step"
      >
        <button
          v-for="tab in SETTINGS_SECTIONS"
          :id="tabIds[tab]"
          :key="tab"
          class="dm-settings__tab"
          type="button"
          role="tab"
          :data-s="tab"
          :aria-selected="shown === tab ? 'true' : 'false'"
          :aria-controls="panelId"
          :tabindex="shown === tab ? 0 : -1"
          @click="show(tab)"
        >
          {{ tab
          }}<span
            v-if="tab === 'General' && brokenShortcut !== null"
            class="dm-warn-dot"
            aria-label="warning"
          ></span>
        </button>
      </div>
      <div
        :id="panelId"
        ref="panel"
        class="dm-settings__panel"
        role="tabpanel"
        :aria-labelledby="tabIds[shown]"
      >
        <h2 class="dm-settings__h">{{ shown }}</h2>

        <template v-if="shown === 'General'">
          <SettingsBanner
            v-if="brokenShortcut !== null"
            :text="brokenShortcut + ' is already in use by another application.'"
          />
          <PositionSettings
            :edge="edge"
            :applying="edgeApplying"
            @select="emit('select-edge', $event)"
          />
          <ShortcutSettings
            :state="shortcutState"
            :error="shortcutError"
            :recording="shortcutRecording"
            :applying="shortcutApplying"
            :autofocus="recorderFocus"
            @start-recording="emit('start-recording')"
            @stop-recording="emit('stop-recording')"
            @record="emit('record', $event)"
            @reset="emit('reset-shortcut')"
            @close="emit('close')"
          />
          <SettingsRow
            label="Always on top"
            help="Pinned: the panel stays above other windows. Unpinned: other windows can cover the panel."
          >
            <ToggleSwitch
              class="pin"
              label="Always on top"
              held
              :on="pinned"
              :title="pinTooltip"
              @update:on="emit('toggle-pin')"
            />
          </SettingsRow>
        </template>

        <TypographySettings
          v-else-if="shown === 'Appearance'"
          :preferences="typography"
          :applying="typographyApplying"
          @change="emit('typography-change', $event)"
        />

        <AudioSettings
          v-else-if="shown === 'Sound'"
          :settings="audioSettings"
          @change="emit('audio-change', $event)"
        />

        <NotificationSettings
          v-else-if="shown === 'Notifications'"
          :enabled="notificationsEnabled"
          @change="emit('notifications-change', $event)"
        />

        <template v-else-if="shown === 'Integrations'">
          <JevSettings
            :settings="jevSettings"
            :saving="jevSaving"
            :providers="jevProviders"
            :catalogs="jevCatalogs"
            @save="emit('jev-save', $event)"
            @clear="emit('jev-clear')"
            @preferences-change="emit('jev-preferences-change', $event)"
          />
          <OpenCodeSettings
            :settings="openCodeSettings"
            :applying="openCodeApplying"
            @plugin-change="emit('opencode-plugin-change', $event)"
            @password-save="emit('opencode-password-save', $event)"
            @password-clear="emit('opencode-password-clear')"
          />
          <JevPrivacyNotice />
        </template>

        <DataBaseSection v-else-if="shown === 'Data'" @open-reset="resetOpen = true" />

        <div v-else class="dm-settings__about">
          <p v-if="versionText" class="version" :title="versionHint">
            <b>DwarfAI-Miners</b> · version <b>{{ versionText }}</b>
          </p>
          <div>
            <ActionButton
              class="hide-panel"
              label="Hide panel"
              title="Hide the panel; the shortcut or the tray brings it back"
              @click="emit('hide-panel')"
            />
          </div>
        </div>
      </div>
    </div>

    <ModalDialog
      :open="resetOpen"
      title="Reset metrics"
      danger
      typed="yes"
      :actions="resetActions"
      @action="resetAction"
      @cancel="resetOpen = false"
    >
      <p>Are you sure you want to delete your data? Type "yes" to confirm.</p>
      <p v-if="resetError" role="alert">{{ resetError }}</p>
    </ModalDialog>
  </section>
</template>

<style scoped>
/* The design's settings.css, rule for rule. */
.dm-settings {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  gap: 4px;
  height: 100%;
  min-height: 0;
}
.dm-settings__body {
  display: grid;
  grid-template-columns: 124px minmax(0, 1fr);
  gap: 8px;
  min-height: 0;
}
.dm-settings__nav {
  display: grid;
  align-content: start;
  gap: 6px;
  padding: 2px;
}
.dm-settings__tab {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: var(--hit-tool);
  padding: 0 8px;
  font: 400 var(--fs-meta) / 1 var(--f-meta);
  color: var(--ink-soft);
  text-align: left;
  background: var(--wood-lo);
  box-shadow: inset 2px 0 0 0 var(--wood);
}
.dm-settings__tab:hover {
  color: var(--ink);
  box-shadow: inset 2px 0 0 0 var(--brass-lo);
  background: var(--wood);
}
.dm-settings__tab[aria-selected='true'] {
  color: var(--ink-on-light);
  background: var(--gold);
  box-shadow:
    inset 2px 2px 0 0 var(--gold-hi),
    inset -2px -2px 0 0 var(--gold-lo);
}
.dm-settings__tab .dm-warn-dot {
  width: 6px;
  height: 6px;
  margin-left: auto;
  background: var(--warn);
  box-shadow: 0 0 0 2px var(--rock-lo);
}
.dm-settings__panel {
  overflow-y: auto;
  padding: 4px 8px 12px 10px;
  background: var(--wood);
  box-shadow:
    inset 2px 2px 0 0 var(--wood-hi),
    inset -2px -2px 0 0 var(--wood-lo);
}
.dm-settings__h {
  font: 400 var(--fs-title) / 1 var(--f-display);
  color: var(--gold);
  padding: 10px 2px 6px;
}
.dm-settings__about {
  display: grid;
  gap: 10px;
  padding: 8px 2px;
  font: 400 var(--fs-body) / 1.35 var(--f-meta);
  color: var(--ink-soft);
}
.dm-settings__about b {
  color: var(--parchment);
  font-weight: 400;
}
</style>
