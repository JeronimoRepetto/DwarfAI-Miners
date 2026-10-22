/*
 * The stored Sound settings (#174; US-SET-004), read and written with no sound at all (ISSUE-304): what main STORED,
 * never the request, since main clamps every volume. `useAudio` reads and writes through this before handing the
 * result to its engine; Valle's Settings page uses it alone, so changing a volume there starts no playback and builds
 * no second audio engine in the Valle window until US-VALLE-016 (owner decision 2026-10-22).
 */
import { ref } from 'vue'
import { DEFAULT_AUDIO_PREFERENCES, parseAudioPreferences, type AudioPreferences } from '../types'

export function useAudioPreferences() {
  const settings = ref<AudioPreferences>({ ...DEFAULT_AUDIO_PREFERENCES })

  /** Adopts what main stored; a bridge that cannot answer leaves the last known settings. */
  async function read(): Promise<void> {
    try {
      settings.value = parseAudioPreferences(await window.api.getAudioPreferences())
    } catch {
      // The last known settings are still the most honest thing to show, and the next call corrects them.
    }
  }

  /** Asks main to store a change and adopts what it stored; answers whether main answered. */
  async function write(patch: Partial<AudioPreferences>): Promise<boolean> {
    const requested = parseAudioPreferences({ ...settings.value, ...patch })
    try {
      settings.value = parseAudioPreferences(await window.api.setAudioPreferences(requested))
      return true
    } catch {
      // The failed write may or may not have reached main; the last known settings stay shown until a later call.
      return false
    }
  }

  return { settings, read, write }
}

export type AudioPreferencesPart = ReturnType<typeof useAudioPreferences>
