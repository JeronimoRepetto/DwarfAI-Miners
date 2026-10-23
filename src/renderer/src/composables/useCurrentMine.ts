import type { MineId, UiSessionPatch } from '@dwarfai/contracts'
import { computed, shallowRef, watch, type ComputedRef } from 'vue'
import {
  CURRENT_MINE_START,
  currentMineOf,
  currentMinePatch,
  mineSound,
  stepCurrentMine,
  type CurrentMineFacts,
  type CurrentMineInput,
  type CurrentMineState
} from '../lib/valle/currentMine'

/*
 * The Valle window's current mine (07 machine 35; US-VALLE-013, US-VALLE-016; UC-060; ISSUE-307): one value for the
 * Valle host, the one the marks draw and the sound engine plays (BR-13, INV-115).
 *
 * - Its state lives here, for this window's run: Valle opens in `fallback` (S35.06) and the current mine is never
 *   persisted (ADR-024 items 1, 4). Each change of the value is written through A-N18 `current-mine` for the Valle host
 *   alone, so the session store names exactly what is marked.
 * - A set mine whose column went (closed, removed, or a climb to a mosaic that lacks it) takes S35.05 by itself.
 * - The sound gate: the engine's scene is the current mine and its ambience mute is that mine's own (`mutedMineIds`),
 *   so only the current, unmuted mine plays its room tone, bed and crew (NFR-SND-02, S31.08). Attention cues and a
 *   selected dwarf's voice go to the engine directly and never pass through here (S35.07); the window's own
 *   visibility gates everything (S35.08, the engine's).
 */

/** What the gate tells the window's one sound engine (`useAudio`). */
export interface CurrentMineSound {
  setScene(mineId: string | null): void
  setAmbienceMuted(muted: boolean): void
}

export interface CurrentMineDeps {
  /** A-N18 (`patchUiSession`). */
  bridge: { patchUiSession(patch: UiSessionPatch): void }
  /** What machine 35 reads now: the preset, the mosaic, the Work front's mine, the chat in focus. */
  facts: () => CurrentMineFacts
  /** The mines muted from their zone menu (`mutedMineIds`). */
  muted: () => readonly MineId[]
  sound: CurrentMineSound
}

export interface CurrentMinePart {
  /** The one current mine, or `null` with no mine on screen. */
  current: ComputedRef<MineId | null>
  /** An input of machine 35; answers whether a listed transition was taken. */
  send(input: CurrentMineInput): boolean
  stop(): void
}

export function useCurrentMine(deps: CurrentMineDeps): CurrentMinePart {
  const state = shallowRef<CurrentMineState>(CURRENT_MINE_START)
  const current = computed(() => currentMineOf(state.value, deps.facts()))

  function send(input: CurrentMineInput): boolean {
    const step = stepCurrentMine(state.value, input, deps.facts())
    if (step.ok) state.value = step.state
    return step.ok
  }

  // S35.05: a set mine no longer a column of the Control room shown.
  const stopGone = watch(
    () => {
      const facts = deps.facts()
      const now = state.value
      return now.kind === 'set' && facts.preset === 'control' && !facts.mosaic.includes(now.mineId)
        ? now.mineId
        : null
    },
    (gone) => {
      if (gone !== null) send({ kind: 'gone', mineId: gone })
    },
    { flush: 'sync', immediate: true }
  )
  const stopPatch = watch(
    current,
    (mineId) => deps.bridge.patchUiSession(currentMinePatch(mineId)),
    {
      flush: 'sync',
      immediate: true
    }
  )
  const stopSound = watch(
    () => mineSound(current.value, deps.muted()),
    (sound) => {
      deps.sound.setAmbienceMuted(sound.muted)
      deps.sound.setScene(sound.mineId)
    },
    { flush: 'sync', immediate: true }
  )

  return {
    current,
    send,
    stop() {
      stopGone()
      stopPatch()
      stopSound()
    }
  }
}
