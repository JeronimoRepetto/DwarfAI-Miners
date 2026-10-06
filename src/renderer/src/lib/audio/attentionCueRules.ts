/*
 * THE LEVEL-2 RULE (ISSUE-117; ADR-018 items 1 and 8, ADR-021 item 3; NFR-SND-04, NFR-SND-07, NFR-SND-08; INV-103).
 *
 * Pure: whether one need's attention cue plays in this window. The renderer of the shown mode window plays it, once
 * per key, only with Notification sounds on (`notificationSoundsOn`, a UI preference, ADR-024); a hidden window plays
 * nothing; an ask with `reannounce: false` plays nothing; a finished turn plays only for a reliable end that was not
 * cancelled from the app.
 *
 * What is deliberately NOT an input: which mode window is shown (Panel, Veta, Valle — Veta included, NFR-SND-07), which
 * mine has focus, and a mine's ambience mute (NFR-SND-04). None of them can silence a cue, so none of them is asked.
 *
 * Level 1 (the asking pose, the "?", the badge) is not decided here: it is drawn from the board alone and has no
 * toggle (US-SHELL-010.AC01).
 */
import type { AttentionSfx } from './volume'

/** ADR-021 item 3: the two facts of a `turn.ended` (B-F14) that decide the finished cue. */
export interface TurnEnd {
  reliability: 'reliable' | 'inferred'
  cancelledFromApp: boolean
}

/** One need, as the cue composable hands it over: an ask (question or permission) or a finished turn. */
export type AttentionCueEvent =
  | {
      kind: Exclude<AttentionSfx, 'finished'>
      dwarfId: string
      askId: string
      /** ADR-010 `AskRecord.reannounce`; an ask from today's board (`LegacyAskRelay`) reads as `true`. */
      reannounce: boolean
    }
  | { kind: 'finished'; dwarfId: string; turnKey: string; end: TurnEnd }

export interface CueGates {
  /** Settings › Sound "Notification sounds" (A-06 `notificationSounds`). */
  soundsOn: boolean
  /** Whether this renderer's window is the shown mode window. */
  windowShown: boolean
  /** Whether this need's key was already seen in this window. */
  alreadyPlayed: boolean
}

/** The need's key, `dwarfId:kind:askId|turnKey`: one cue per key, ever. */
export function cueKey(event: AttentionCueEvent): string {
  const id = event.kind === 'finished' ? event.turnKey : event.askId
  return `${event.dwarfId}:${event.kind}:${id}`
}

/** ADR-021 item 3: the finished cue iff `reliability === 'reliable' && !cancelledFromApp`. */
export function isAnnounceableEnd(end: TurnEnd): boolean {
  return end.reliability === 'reliable' && !end.cancelledFromApp
}

export function shouldPlayCue(event: AttentionCueEvent, gates: CueGates): boolean {
  if (!gates.soundsOn || !gates.windowShown || gates.alreadyPlayed) return false
  return event.kind === 'finished' ? isAnnounceableEnd(event.end) : event.reannounce
}
