import { watch, type Ref } from 'vue'
import { HOST_FRAME_SCHEMAS, type HostFrame } from '@dwarfai/contracts'
import type { AudioPreferences, Mine } from '../types'
import {
  cueKey,
  shouldPlayCue,
  type AttentionCueEvent,
  type TurnEnd
} from '../lib/audio/attentionCueRules'
import { ATTENTION_SFX_KINDS, type AttentionSfx } from '../lib/audio/volume'
import { useMines } from './useMines'

/*
 * LEVEL 2: THE ATTENTION CUES (ISSUE-117; ADR-018 items 1 and 8, ADR-021 item 3; 05 §3.14; 07 §17).
 *
 * The renderer of the shown mode window plays one cue per need — a question, a permission, a finished turn — once
 * per key (`dwarfId:kind:askId|turnKey`), only with Notification sounds on, through the sound engine. Whether one
 * plays is `attentionCueRules`; this composable only feeds it the Host facts and remembers the keys.
 *
 * Fed by:
 * - The board read model (`useMines`). In cut 1 its asks come from `LegacyAskRelay` through `BoardFacadeAdapter`,
 *   keyed by the ask id the relay carries (the `toolUseId`) and read as `reannounce: true` (lead decision
 *   2026-09-30); its `lastTurn` is the provider's own end-of-turn message, so a reliable end, keyed by `endedAt`.
 * - `askOpened`, the intake for the question read model of ISSUE-138 (cut 2), which carries `reannounce`.
 * - `turn.ended` (B-F14), from A-N02.
 *
 * Every need is SEEN once and only once, whether it played or not: a need that began while the window was hidden or
 * the setting off is not announced later when either changes — "starts needing" is a moment, not a state.
 *
 * The first board that carries a dwarf is a baseline and announces nothing: a window that opens on three dwarfs
 * already asking heard none of them begin (a snapshot is never an arrival). After it, a dwarf seen for the first time
 * that already asks is judged like any other: its arrival is where the ask began for this window.
 *
 * At most one cue of a kind per batch, in the fixed order question, permission, finished: the engine holds one clip
 * of a kind at a time, so five dwarfs asking on one poll would only open five clips that cut each other off.
 *
 * Never consulted: a mine's ambience mute, which mine has focus, which mode window is shown (NFR-SND-04, NFR-SND-07).
 * Level 1 (pose, "?", badge) is drawn from the board alone and nothing here touches the board.
 *
 * A singleton, like `useMines`: one renderer, one set of keys, whatever component asks for it.
 */

/** One ask, as the question read model states it. */
export interface AskCue {
  dwarfId: string
  kind: Exclude<AttentionSfx, 'finished'>
  askId: string
  /** ADR-010 `AskRecord.reannounce`: false for an ask re-raised after a silent resume (ADR-018 item 3). */
  reannounce: boolean
}

/** What the cues need of the sound composable (`useAudio`): A-06's settings, the window's visibility, the engine. */
export interface AttentionCueSound {
  settings: Readonly<Ref<AudioPreferences>>
  windowShown: Readonly<Ref<boolean>>
  playSfx: (kind: AttentionSfx) => void
}

/** Today's board ends are the provider's own end-of-turn message (`TurnOutcome.endedAt`), never a silence. */
const BOARD_END_RELIABILITY: TurnEnd['reliability'] = 'reliable'

let sound: AttentionCueSound | null = null
/** Every need key this window has seen, played or not. */
const seen = new Set<string>()
/** Whether a board with a dwarf on it has been seen yet. */
let baselined = false

function needsOnBoard(mines: readonly Mine[]): AttentionCueEvent[] {
  const needs: AttentionCueEvent[] = []
  for (const mine of mines) {
    for (const dwarf of mine.dwarfs) {
      if (dwarf.pendingQuestion !== undefined) {
        needs.push({
          kind: 'question',
          dwarfId: dwarf.id,
          askId: dwarf.pendingQuestion.toolUseId,
          reannounce: true
        })
      }
      if (dwarf.pendingPermission !== undefined) {
        needs.push({
          kind: 'permission',
          dwarfId: dwarf.id,
          askId: dwarf.pendingPermission.toolUseId,
          reannounce: true
        })
      }
      if (dwarf.lastTurn !== undefined) {
        needs.push({
          kind: 'finished',
          dwarfId: dwarf.id,
          turnKey: String(dwarf.lastTurn.endedAt),
          end: {
            reliability: BOARD_END_RELIABILITY,
            cancelledFromApp: dwarf.lastTurn.cancelledFromApp === true
          }
        })
      }
    }
  }
  return needs
}

/** Sees each need of one batch and plays at most one cue per kind for the ones that are due. */
function announce(needs: readonly AttentionCueEvent[], quiet = false): void {
  const due = new Set<AttentionSfx>()
  for (const need of needs) {
    const key = cueKey(need)
    const alreadyPlayed = seen.has(key)
    seen.add(key)
    if (quiet || sound === null) continue
    const gates = {
      soundsOn: sound.settings.value.notificationSounds,
      windowShown: sound.windowShown.value,
      alreadyPlayed
    }
    if (shouldPlayCue(need, gates)) due.add(need.kind)
  }
  for (const kind of ATTENTION_SFX_KINDS) if (due.has(kind)) sound?.playSfx(kind)
}

function observeBoard(mines: readonly Mine[]): void {
  const needs = needsOnBoard(mines)
  if (!baselined) {
    if (!mines.some((mine) => mine.dwarfs.length > 0)) return
    baselined = true
    announce(needs, true)
    return
  }
  announce(needs)
}

function observeFrames(frames: readonly HostFrame[]): void {
  const needs: AttentionCueEvent[] = []
  for (const frame of frames) {
    if (frame.name !== 'turn.ended') continue
    const parsed = HOST_FRAME_SCHEMAS['turn.ended'].safeParse(frame.data)
    if (!parsed.success) continue
    const { dwarfId, turnKey, reliability, cancelledFromApp } = parsed.data
    needs.push({ kind: 'finished', dwarfId, turnKey, end: { reliability, cancelledFromApp } })
  }
  if (needs.length > 0) announce(needs)
}

export function useAttentionCues() {
  return {
    /**
     * Starts hearing the board and A-N02 with `next` as the sound to play through; answers the stop, which forgets
     * every key so a later start begins from a fresh baseline.
     */
    start(next: AttentionCueSound): () => void {
      sound = next
      seen.clear()
      baselined = false
      const unwatch = watch(() => useMines().state.mines, observeBoard, {
        immediate: true,
        flush: 'sync'
      })
      const unlisten = window.api.onHostEvent((frames) => observeFrames(frames as HostFrame[]))
      return () => {
        unwatch()
        unlisten()
        if (sound === next) sound = null
        seen.clear()
        baselined = false
      }
    },
    /** An ask the question read model opened (cut 2, ISSUE-138): an event, judged on arrival. */
    askOpened(ask: AskCue): void {
      announce([{ ...ask }])
    }
  }
}
