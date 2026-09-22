<script setup lang="ts">
import { ref } from 'vue'
import { motion } from 'motion-v'
import type {
  AgentModelCatalog,
  AgentProviderOption,
  AudioPreferences,
  JevPreferences,
  JevSettings as JevSettingsType,
  PanelEdge,
  ShortcutState,
  TypographyPreferences
} from '../../types'
import { pressHoverVariants } from '../../lib/shell/presence'
import AudioSettings from './AudioSettings.vue'
import DataBaseSection from './DataBaseSection.vue'
import JevSettings from './JevSettings.vue'
import NotificationSettings from './NotificationSettings.vue'
import PositionSettings from './PositionSettings.vue'
import ResetMetricsModal from './ResetMetricsModal.vue'
import ShortcutSettings from './ShortcutSettings.vue'
import TypographySettings from './TypographySettings.vue'
import PanelTransition from '../shell/PanelTransition.vue'

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
 * The AUDIO section (#174) is a maintainer-specified extension of
 * `screens/settings.md`, which has none; it sits between Position and Data
 * Base, which is after everything the design draws and before the one
 * destructive action. NOTIFICATIONS (#316) is the second such extension and
 * lands in the same gap, immediately after Audio — the design source itself
 * names it as joining there. TYPOGRAPHY (#370) is the third, and the only one
 * whose place the source states outright: after Position and before Audio.
 * JEV (#509) is the fourth, and lands right after Notifications — the same
 * gap, one section further in.
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
  /** What Settings' Audio section has stored (#174, #173) — main's verdict. */
  audioSettings: AudioPreferences
  /* --- System notifications (#316) — one block, appended ------------------- */
  /** Whether the OS notification centre may be used — main's verdict, not a wish. */
  notificationsEnabled: boolean
  /* --- end of the #316 block ---------------------------------------------- */
  /* --- Typography preferences (#370) — one block, appended ----------------- */
  /** Which faces the interface and messaging are drawn in — main's verdict. */
  typography: TypographyPreferences
  /** True while a face change is in flight; locks the segments. */
  typographyApplying: boolean
  /* --- end of the #370 block ----------------------------------------------- */
  /* --- Jev launch routing: the API key setting (#509) — one block, appended - */
  /** Whether a TypeSafe key is configured, and why it might never be — main's verdict. */
  jevSettings: JevSettingsType
  /** True while a save or a clear this section asked for is in flight. */
  jevSaving: boolean
  /* --- end of the #509 block ------------------------------------------------ */
  /* --- Jev routing profiles: profile and defaults (#509 follow-up) — one block, appended --- */
  /** Every known provider's availability — for the default-launch picker. */
  jevProviders: AgentProviderOption[]
  /** What each provider can start on — for the default-launch model/effort pickers. */
  jevCatalogs: AgentModelCatalog[]
  /* --- end of the #509 follow-up block --------------------------------------- */
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
  /** One field of the Audio settings should change (#174). */
  'audio-change': [patch: Partial<AudioPreferences>]
  /* --- System notifications (#316) — one block, appended ------------------- */
  /** The notifications switch should take this value (#316). */
  'notifications-change': [enabled: boolean]
  /* --- end of the #316 block ---------------------------------------------- */
  /* --- Typography preferences (#370) — one block, appended ----------------- */
  /** One typography role should take a face (#370) — a patch, never the pair. */
  'typography-change': [patch: Partial<TypographyPreferences>]
  /* --- end of the #370 block ----------------------------------------------- */
  /* --- Jev launch routing: the API key setting (#509) — one block, appended - */
  /** Enter or replace the TypeSafe key with this one. */
  'jev-save': [key: string]
  /** Forget the stored key. */
  'jev-clear': []
  /* --- end of the #509 block ------------------------------------------------ */
  /* --- Jev routing profiles: profile and defaults (#509 follow-up) — one block, appended --- */
  /** The routing profile and/or the default launch should become this whole document. */
  'jev-preferences-change': [preferences: JevPreferences]
  /* --- end of the #509 follow-up block --------------------------------------- */
}>()

const resetModalOpen = ref(false)
</script>

<template>
  <div class="settings-panel">
    <header class="settings-head">
      <h1 class="settings-title">Settings</h1>
      <div class="settings-divider" role="presentation"></div>
    </header>

    <!--
      The sections are ruled into GROUPS (maintainer request, 2026-09-21).

      Settings grew from the design's three sections to eight, each drawing
      its own heading — `settings.md` records the growth itself, "previously
      listed three sections and now lists four", then five. Eight headings in
      one column with nothing between them stopped reading as a list.

      A rule between groups, never between every section: the point is to say
      which sections belong together, and a rule after each one says nothing.
      The first group is the two the design source already names as a pair,
      `Panel shortcut` and `Panel position`; the last keeps Data Base with
      Application, which DataBaseSection's own comment already treats as one
      bottom cluster.

      No group headings. Every section draws its own name, and a heading over
      them would print half of those names twice.
    -->
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

    <div class="group-divider" role="presentation"></div>

    <TypographySettings
      :preferences="typography"
      :applying="typographyApplying"
      @change="emit('typography-change', $event)"
    />

    <div class="group-divider" role="presentation"></div>

    <AudioSettings :settings="audioSettings" @change="emit('audio-change', $event)" />

    <div class="group-divider" role="presentation"></div>

    <NotificationSettings
      :enabled="notificationsEnabled"
      @change="emit('notifications-change', $event)"
    />

    <div class="group-divider" role="presentation"></div>

    <JevSettings
      :settings="jevSettings"
      :saving="jevSaving"
      :providers="jevProviders"
      :catalogs="jevCatalogs"
      @save="emit('jev-save', $event)"
      @clear="emit('jev-clear')"
      @preferences-change="emit('jev-preferences-change', $event)"
    />

    <div class="group-divider" role="presentation"></div>

    <DataBaseSection @open-reset="resetModalOpen = true" />

    <section class="application-settings">
      <span class="field-label">Application</span>
      <div class="application-controls">
        <motion.button
          class="pin"
          type="button"
          aria-label="Keep panel on top"
          :aria-pressed="pinned ? 'true' : 'false'"
          :title="pinTooltip"
          v-bind="pressHoverVariants"
          @click="emit('toggle-pin')"
        >
          Always on top
        </motion.button>
        <motion.button
          class="hide-panel"
          type="button"
          title="Hide the panel; the shortcut or the tray brings it back"
          v-bind="pressHoverVariants"
          @click="emit('hide-panel')"
        >
          Hide panel
        </motion.button>
        <span v-if="versionText" class="version" :title="versionHint">{{ versionText }}</span>
      </div>
    </section>

    <PanelTransition axis="vertical">
      <ResetMetricsModal
        v-if="resetModalOpen"
        :confirming="resetting"
        :error="resetError"
        @confirm="emit('reset-confirm')"
        @close="resetModalOpen = false"
      />
    </PanelTransition>
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
/*
 * The rule between groups. Deliberately 1px where the title's is 2px: the
 * heavier line belongs to the panel's own name, and a group boundary that
 * matched it would flatten the two into one level. The design source draws no
 * grouping at all — `screens/settings.md` has grown by maintainer amendment
 * three times without one — so the weight is ours, recorded here the way
 * `--size-scrollbar-width` and `--elevation-5` record theirs.
 */
.group-divider {
  flex: none;
  height: 1px;
  background: var(--color-accent);
}
.application-settings {
  display: flex;
  flex-direction: column;
  gap: var(--space-settings);
  /* The design draws nothing here (#142's unspecified placement). No auto
     margin of its own: DataBaseSection's already carries the bottom cluster
     down (see its own comment), and this simply follows it in flow, reading
     as furniture below the one destructive action rather than a fourth
     designed section. */
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
  border: 2px solid var(--color-control-idle);
  color: var(--color-control-idle);
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
