<script setup lang="ts">
import type { AudioPreferences } from '../../types'

/**
 * The Audio section of the Settings screen (#174, with #173's two volumes).
 *
 * A maintainer-specified EXTENSION of `screens/settings.md`, which has no
 * Audio section at all — the amendment text is proposed with this change and
 * the maintainer applies it (ui-rebuild discipline). Everything drawn here
 * reuses the design's existing vocabulary rather than inventing one: the
 * section label of Position and Data Base, the shared button model for the
 * startup toggle, and the active-border amber for the filled part of a slider.
 * The slider itself is the one shape the source does not draw; it is marked
 * **Unspecified** there, and this is the gap being surfaced rather than
 * silently filled with taste.
 *
 * Presentational, like every settings piece: the stored settings arrive as a
 * prop and every intent leaves as one `change` event carrying only the field
 * that moved, so App.vue keeps owning the IPC and the "render only what main
 * verified" rule stays in exactly one place. A slider dragged to 0.25 shows
 * 0.25 only once main has answered with it.
 */
const props = defineProps<{
  settings: AudioPreferences
}>()

const emit = defineEmits<{
  /** One field of the Audio settings should change. */
  change: [patch: Partial<AudioPreferences>]
}>()

/** Percent for the readout beside each slider; the sliders themselves are 0..1. */
function percent(value: number): string {
  return `${Math.round(value * 100)}%`
}

/**
 * Bound `:value` and `@input` by hand rather than `v-model`, deliberately:
 * `v-model` would write the drag straight back into the control, so the slider
 * would sit wherever the pointer left it even if main stored something else.
 * This asks, and redraws from the answer.
 */
function ask(field: keyof AudioPreferences, event: Event): void {
  const raw = (event.target as HTMLInputElement).value
  emit('change', { [field]: Number(raw) })
}
</script>

<template>
  <section class="audio-settings">
    <span class="field-label">Audio</span>

    <div class="startup-row">
      <button
        class="music-at-startup"
        type="button"
        aria-label="Play music at startup"
        :aria-pressed="props.settings.musicAtStartup ? 'true' : 'false'"
        :title="
          props.settings.musicAtStartup
            ? 'Music starts playing when DwarfAI-Miners launches'
            : 'DwarfAI-Miners launches silent; the shell button starts the music'
        "
        @click="emit('change', { musicAtStartup: !props.settings.musicAtStartup })"
      >
        Music at startup
      </button>
    </div>

    <label class="slider-row">
      <span class="slider-name">Music</span>
      <input
        class="music-volume"
        type="range"
        min="0"
        max="1"
        step="0.05"
        aria-label="Music volume"
        :value="props.settings.musicVolume"
        @input="ask('musicVolume', $event)"
      />
      <span class="music-readout readout">{{ percent(props.settings.musicVolume) }}</span>
    </label>

    <label class="slider-row">
      <span class="slider-name">Ambience</span>
      <input
        class="ambience-volume"
        type="range"
        min="0"
        max="1"
        step="0.05"
        aria-label="Mine ambience volume"
        :value="props.settings.ambienceVolume"
        @input="ask('ambienceVolume', $event)"
      />
      <span class="ambience-readout readout">{{ percent(props.settings.ambienceVolume) }}</span>
    </label>

    <label class="slider-row">
      <span class="slider-name">Voices</span>
      <input
        class="voice-volume"
        type="range"
        min="0"
        max="1"
        step="0.05"
        aria-label="Dwarf voice volume"
        :value="props.settings.voiceVolume"
        @input="ask('voiceVolume', $event)"
      />
      <span class="voice-readout readout">{{ percent(props.settings.voiceVolume) }}</span>
    </label>

    <p class="hint">
      Music plays while the shell is open; the mine's ambience and a dwarf's voice only inside a
      mine.
    </p>
  </section>
</template>

<style scoped>
.audio-settings {
  display: flex;
  flex-direction: column;
  gap: var(--space-settings);
}
.field-label {
  padding-top: var(--space-settings);
  color: var(--color-cream);
  font-size: var(--text-section);
}
.startup-row {
  display: flex;
}
/* The shared button model (components.md): the pressed state reads as an
   active control, the unpressed one fades to the deep background — the same
   pair Settings' own "Always on top" already draws. */
.music-at-startup {
  padding: 6px var(--space-settings);
  border: var(--border-active);
  border-radius: var(--radius-default);
  color: var(--color-cream);
  background: var(--color-control);
  font: inherit;
  font-size: var(--text-meta);
  cursor: pointer;
}
.music-at-startup[aria-pressed='false'] {
  border: 2px solid var(--color-control);
  color: var(--color-control);
  background: var(--color-panel-deep);
}
.music-at-startup:focus-visible,
.slider-row input:focus-visible {
  outline: 2px solid var(--color-cream);
  outline-offset: 2px;
}
.slider-row {
  display: flex;
  align-items: center;
  gap: var(--space-settings);
  color: var(--color-cream);
  font-size: var(--text-meta);
}
/* A fixed column for the three names and a fixed one for the three readouts,
   so the sliders line up under each other rather than each starting wherever
   its own label happens to end. */
.slider-name {
  flex: none;
  width: 72px;
}
.readout {
  flex: none;
  width: 40px;
  color: var(--color-accent);
  text-align: end;
}
/*
 * The one shape the design source does not draw (it marks control states
 * Unspecified), built entirely out of tokens it does draw: the track is the
 * deep panel background inside the active amber border, and the thumb is the
 * cream every other control's highlight uses. Squared rather than round,
 * because nothing in this interface is a circle except the three round mine
 * actions.
 */
.slider-row input[type='range'] {
  flex: 1;
  min-width: 0;
  height: 14px;
  border: var(--border-active);
  border-radius: var(--radius-default);
  background: var(--color-panel-deep);
  appearance: none;
  cursor: pointer;
}
.slider-row input[type='range']::-webkit-slider-thumb {
  width: 10px;
  height: 10px;
  border: 0;
  background: var(--color-cream);
  appearance: none;
}
.hint {
  margin: 0;
  color: var(--color-cream);
  font-size: var(--text-helper);
  line-height: 1.4;
}
</style>
