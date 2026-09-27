<script setup lang="ts">
import type { AudioPreferences } from '../../types'
import ToggleSwitch from '../controls/ToggleSwitch.vue'
import VolumeSlider from '../controls/VolumeSlider.vue'
import SettingsRow from './SettingsRow.vue'

/**
 * Settings › Sound (#174, #173, #635): music at startup, and the three volumes.
 *
 * The third row is `Effects` rather than `Voices` since #323: the slider it draws scales the
 * interface sounds as well as the dwarf barks, because they are one channel (see volume.ts), and a
 * row named after half of what it moves is a label that lies. The stored field is still
 * `voiceVolume` — the name of a value that crosses processes is not a label, and renaming it would
 * be a migration bought for nothing.
 *
 * The rows are the design's (screens/settings.md, W6: "Sound is music at startup and the three
 * sliders"); the copy is today's. The design's "Notification sounds" row is not drawn: it switches
 * the attention cues of a later slice, which the app does not play yet, and a switch that changes
 * nothing is a control that lies (PR5 question).
 *
 * Presentational, like every settings piece: the stored settings arrive as a prop and every intent
 * leaves as one `change` event carrying only the field that moved, so App.vue keeps owning the IPC
 * and the "render only what main verified" rule stays in exactly one place. The switch and the
 * sliders are held: a volume dragged to 25% reads 25% only once main has answered with it. The
 * sliders speak whole percentages (atoms/slider) and the stored volumes fractions of 1.
 */
const props = defineProps<{
  settings: AudioPreferences
}>()

const emit = defineEmits<{
  /** One field of the Audio settings should change. */
  change: [patch: Partial<AudioPreferences>]
}>()

type Volume = 'musicVolume' | 'ambienceVolume' | 'voiceVolume'

/** A stored fraction of 1 as the slider's whole percentage. */
function percent(value: number): number {
  return Math.round(value * 100)
}

function ask(field: Volume, value: number): void {
  emit('change', { [field]: value / 100 })
}
</script>

<template>
  <SettingsRow
    label="Music at startup"
    help="Music starts playing when DwarfAI-Miners launches. Off, it launches silent and the shell button starts the music."
  >
    <ToggleSwitch
      class="music-at-startup"
      label="Play music at startup"
      held
      :on="props.settings.musicAtStartup"
      :title="
        props.settings.musicAtStartup
          ? 'Music starts playing when DwarfAI-Miners launches'
          : 'DwarfAI-Miners launches silent; the shell button starts the music'
      "
      @update:on="emit('change', { musicAtStartup: $event })"
    />
  </SettingsRow>
  <SettingsRow label="Music" stack>
    <VolumeSlider
      class="music-volume"
      label="Music volume"
      held
      :value="percent(props.settings.musicVolume)"
      @update:value="ask('musicVolume', $event)"
    />
  </SettingsRow>
  <SettingsRow label="Ambience" stack>
    <VolumeSlider
      class="ambience-volume"
      label="Mine ambience volume"
      held
      :value="percent(props.settings.ambienceVolume)"
      @update:value="ask('ambienceVolume', $event)"
    />
  </SettingsRow>
  <SettingsRow
    label="Effects"
    stack
    help="Music plays while the shell is open, and the mine’s ambience only inside a mine. Effects are a dwarf’s voice and the interface’s own sounds."
  >
    <VolumeSlider
      class="voice-volume"
      label="Dwarf voice and interface sound volume"
      held
      :value="percent(props.settings.voiceVolume)"
      @update:value="ask('voiceVolume', $event)"
    />
  </SettingsRow>
</template>
