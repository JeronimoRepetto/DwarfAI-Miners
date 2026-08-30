import { computed, ref } from 'vue'
import {
  DEFAULT_TOGGLE_ACCELERATOR,
  buildAccelerator,
  isModifierKey
} from '../../../shared/accelerator'
import type { ShortcutState } from '../types'

/**
 * State for the panel-toggle shortcut recorder (see #17).
 *
 * Same honesty rule as usePinnedWindow, and for a sharper reason: `state` only
 * ever changes to a ShortcutState that came back from the main process. A
 * combination another application owns is refused there and reverted, so
 * rendering the requested accelerator would tell the user a shortcut works
 * when nothing at all is bound to it.
 *
 * The recording half is deliberately local and pure: the keydown is translated
 * by shared/accelerator and only travels over IPC once it is a shortcut we are
 * willing to claim machine-wide. That keeps every half-typed chord — and every
 * refusal the user can fix by pressing something else — out of the main process.
 *
 * Like usePinnedWindow there is no module-scope singleton: the settings panel
 * is the only consumer, so each call owns fresh refs and the tests stay
 * independent without a clearAll() ritual.
 */
export function useToggleShortcut() {
  // No first guess: unlike "pinned", neither the stored accelerator nor
  // whether it registered can be inferred, so the panel renders a loading
  // state until main answers rather than inventing a plausible one.
  const state = ref<ShortcutState | null>(null)
  const recording = ref(false)
  const applying = ref(false)
  /** A refusal produced here (the chord is not a shortcut), not by main. */
  const recordError = ref<string | null>(null)

  /**
   * What to show the user. A fresh local refusal wins over main's older
   * report, because it is about the key they just pressed.
   */
  const error = computed<string | null>(() => recordError.value ?? state.value?.error ?? null)

  /** Adopt the real state; on failure keep the last known one. */
  async function sync(): Promise<void> {
    try {
      state.value = await window.api.getToggleShortcut()
    } catch {
      // The bridge is unreachable: the last known state is still the most
      // honest thing we can render, and the next successful call corrects it.
    }
  }

  function startRecording(): void {
    recordError.value = null
    recording.value = true
  }

  function stopRecording(): void {
    recording.value = false
  }

  /**
   * Ask main to bind `accelerator`, and adopt whatever it reports back — which
   * may be the PREVIOUS combination plus a reason.
   */
  async function apply(accelerator: string): Promise<void> {
    // A second request while one is in flight would race, and the two verdicts
    // could land out of order (same reasoning as usePinnedWindow's toggle).
    if (applying.value) return
    applying.value = true
    recordError.value = null
    try {
      state.value = await window.api.setToggleShortcut(accelerator)
    } catch {
      // The call broke somewhere in between and may or may not have applied:
      // re-read the real state rather than assume either outcome, and say so.
      recordError.value = 'The shortcut could not be changed.'
      await sync()
    } finally {
      applying.value = false
    }
  }

  /** Put the documented Ctrl+Alt+Shift+P back, retrying registration if it had failed. */
  async function reset(): Promise<void> {
    await apply(DEFAULT_TOGGLE_ACCELERATOR)
  }

  /**
   * One keydown from the recorder input. Swallows the keystroke while
   * listening so Tab does not move focus and Space does not re-click the
   * button the user is recording into.
   */
  async function record(event: KeyboardEvent): Promise<void> {
    if (!recording.value) return
    event.preventDefault()

    // Escape is the way out of a recorder that has taken over the keyboard,
    // which is also why it can never itself be a shortcut.
    if (event.key === 'Escape') {
      stopRecording()
      return
    }

    // Still reaching for the key: staying quiet avoids flashing an error on
    // the way to every perfectly good combination.
    if (isModifierKey(event.key)) return

    const built = buildAccelerator({
      code: event.code,
      key: event.key,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      metaKey: event.metaKey
    })
    if (!built.ok) {
      // Keep listening: the fix is simply to press something else, and
      // dropping out of recording would make the user click the button again.
      recordError.value = built.reason
      return
    }

    stopRecording()
    await apply(built.accelerator)
  }

  return {
    state,
    error,
    recording,
    applying,
    sync,
    startRecording,
    stopRecording,
    record,
    apply,
    reset
  }
}
