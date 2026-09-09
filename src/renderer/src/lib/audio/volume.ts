/**
 * How a stored preference becomes the number a clip is actually played at
 * (#174, #173).
 *
 * Two things are multiplied and there is no third. The BASE volume is the
 * issues' own mixing decision — music at 100 %, the mine's ambience at 50 %, a
 * dwarf's voice at 75 % — which exists because the three channels are recorded
 * at whatever level they were recorded at and a slider at full must not be
 * three sources shouting over each other. The SETTING is the person's own
 * fraction of that.
 *
 * The gates come last and only ever subtract. They are the same facts the
 * ambience machine reads (see ambience.ts) and they are applied in BOTH
 * places on purpose: the machine stops a bed that should not be playing, and
 * this returns 0 for anything that reaches a clip anyway. Two answers to one
 * question is usually a smell; here the second one is the floor under a bug in
 * the first, and the cost of it is a multiplication.
 */
import type { AudioPreferences } from '../../types'
import { clampAudioVolume, DEFAULT_AUDIO_PREFERENCES } from '../../types'

export const AUDIO_CHANNELS = ['music', 'ambience', 'voice'] as const

export type AudioChannel = (typeof AUDIO_CHANNELS)[number]

/**
 * The issues' own levels, and the only place they appear.
 *
 * `satisfies` rather than an annotation, so the record has to name every
 * channel and cannot grow a fourth key nothing mixes.
 */
export const AUDIO_BASE_VOLUME = {
  music: 1,
  ambience: 0.5,
  voice: 0.75
} satisfies Record<AudioChannel, number>

/**
 * What the app's own visibility does to sound, as two independent facts.
 *
 * `hidden` is main's answer about the shell WINDOW — minimised, or hidden by
 * the shortcut or the tray — and it silences everything (#174). `collapsed` is
 * the shell drawn as its bare rail, which silences the ambience and the voices
 * and leaves the music playing, because a rail on screen is still the app
 * being used.
 */
export interface AudioGates {
  hidden: boolean
  collapsed: boolean
}

/** Which channels survive a shell collapsed to its rail: the music, alone. */
const SURVIVES_COLLAPSE: Record<AudioChannel, boolean> = {
  music: true,
  ambience: false,
  voice: false
}

/** Which of the three stored volumes scales each channel. */
type AudioVolumeKey = 'musicVolume' | 'ambienceVolume' | 'voiceVolume'

const SETTING_OF: Record<AudioChannel, AudioVolumeKey> = {
  music: 'musicVolume',
  ambience: 'ambienceVolume',
  voice: 'voiceVolume'
}

/**
 * The volume one channel plays at right now: base x setting, or 0 when a gate
 * is shut.
 *
 * A setting that is not a finite fraction falls back to its DEFAULT rather
 * than to 0, which is `clampAudioVolume`'s rule and worth restating here: a
 * `NaN` read as silence is a bug that looks exactly like a deliberate mute,
 * and nobody would ever report it.
 */
export function channelVolume(
  channel: AudioChannel,
  settings: AudioPreferences,
  gates: AudioGates
): number {
  if (gates.hidden) return 0
  if (gates.collapsed && !SURVIVES_COLLAPSE[channel]) return 0
  const key = SETTING_OF[channel]
  const setting = clampAudioVolume(settings[key], DEFAULT_AUDIO_PREFERENCES[key])
  return AUDIO_BASE_VOLUME[channel] * setting
}
