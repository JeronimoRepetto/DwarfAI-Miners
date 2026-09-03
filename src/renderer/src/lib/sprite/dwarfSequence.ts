/**
 * Which strips a dwarf plays, and in what order (issues #74, #87).
 *
 * ## The interruption rule
 *
 * A CHANGE OF STATE ALWAYS RESTARTS THE SEQUENCE, AND A TRANSITION CAUGHT
 * MID-PLAY IS ABANDONED WHERE IT STANDS. A foreman answered while he is still
 * lying down cuts straight to getting up; asked again while getting up cuts
 * straight back to lying down. A worker sent home mid pick-up cuts straight
 * to setting the pick back down, never finishing the swing it was caught
 * starting.
 *
 * It is worth the sentence because the obvious alternative — letting a `once`
 * clip finish before honouring the new state — is what strands a sprite: two
 * quick changes and the drawing is a state behind the dwarf, with no bound on
 * how far behind it can fall. Here the clips are a pure function of two
 * independent (state, wasState) pairs — one for being asked a question, one
 * for working — so the same four values always produce the same sequence
 * however the dwarf arrived at them, and there is no partial playback to
 * unwind.
 *
 * The two pairs are independent in name only. `isAwaitingAnswer` never returns
 * true for a working dwarf, so a real dwarf is never in both current states at
 * once — but a dwarf CAN carry a true past on one axis into a render where the
 * other axis has since gone true (asked a question, then put straight to
 * work). Being asked a question is checked first, ahead of the working axis
 * entirely, both for entering it and for the transition OUT of it: leaving a
 * blocked state is always resolved before the working axis is ever consulted.
 * That ordering is what keeps a foreman's end-sleep transition from being
 * skipped the instant his status flips straight from being asked to
 * 'working' — see `dwarfClips`'s own note below for why it has to be exactly
 * this way round.
 *
 * ## What is drawn and what is not
 *
 * A rank falls back to its OWN idle for a state it has no sheet for, and never
 * to the other rank's art — borrowing across ranks is exactly how the foreman
 * ended up walking like a miner (#74). A missing TRANSITION is dropped rather
 * than substituted, because an idle played once before an idle looped is a
 * stutter, not a movement.
 *
 * Today that means a worker also plays a working sequence of its own — picked
 * up once, swings on a loop, set down once on the way out — while waiting,
 * walking and leaving (without having worked first) still fall back to the
 * one idle loop, because none of those has been drawn. Only the foreman's
 * sleep is drawn besides. The panel has not stopped saying which state a
 * dwarf is in — the `z z z` overlay still marks a resting one and the leaving
 * fade still marks a departure — but the SPRITE says it only where the art
 * exists.
 */
import type { DwarfRole, DwarfStatus, WaitingReason } from '../../types'
import { WAITING_ON_HUMAN_REASON } from '../../types'
import { DWARF_SHEETS, type DwarfSheetName, type DwarfSheetSet } from './dwarfSheets'
import { loopOf, onceOf, type SequencePosition, type SpriteClip } from './spriteSheet'

/**
 * Whether this dwarf is blocked on a person answering it (issue #60).
 *
 * The reason is passed through from the provider and never re-derived: only a
 * provider knows whether a human was actually asked something, and one proven
 * value picks this out. An approval and an open dialog rest exactly as they
 * always have — the panel may single a dwarf out for attention only where a
 * provider proved a person was asked, never on a reason that might mean one.
 */
export function isAwaitingAnswer(status: DwarfStatus, waitingReason?: WaitingReason): boolean {
  if (status === 'working' || status === 'leaving') return false
  return waitingReason === WAITING_ON_HUMAN_REASON
}

/** The looping sheet for a state, or the rank's idle where none was drawn. */
function settleOn(sheets: DwarfSheetSet, name: DwarfSheetName): SpriteClip {
  return loopOf(sheets[name] ?? sheets.idle)
}

/** The transition into a state, or nothing at all where none was drawn. */
function transition(sheets: DwarfSheetSet, name: DwarfSheetName): SpriteClip[] {
  const sheet = sheets[name]
  return sheet === undefined ? [] : [onceOf(sheet)]
}

/**
 * The clips to play now.
 *
 * `wasAwaiting` and `wasWorking` are the PREVIOUS answers on each axis, which
 * is what turns a state into a transition — `undefined` on either is a first
 * render, where a dwarf that arrives already in that state still plays the
 * transition into it (there is nothing to interrupt, and a dwarf spawned
 * already asleep or already mid-swing reads as a bug) but one that arrives
 * free of it does not play a transition out of a state it never held.
 *
 * `working` defaults to `false` and `wasWorking` to `undefined` so a caller
 * with nothing to say about work — every call site written before this axis
 * existed — gets exactly the sleep-only behaviour it always did.
 *
 * The branch order is load-bearing, not incidental: being asked a question is
 * checked first (current, then its exit) and the working axis only after
 * both. A dwarf can never be CURRENTLY both — `isAwaitingAnswer` already rules
 * that out — so the first `if` is a plain priority pick when it happens to
 * fire. What the order actually protects is the SECOND `if`: without it
 * running before the working checks, a foreman whose status flips straight
 * from being asked to `'working'` would have his end-sleep transition
 * skipped, because `working` would already be true on that very render. Sleep
 * finishing what it started always comes before work gets a say.
 */
export function dwarfClips(
  role: DwarfRole,
  awaiting: boolean,
  wasAwaiting: boolean | undefined,
  working = false,
  wasWorking: boolean | undefined = undefined
): readonly SpriteClip[] {
  const sheets = DWARF_SHEETS[role]
  if (awaiting) {
    if (wasAwaiting === true) return [settleOn(sheets, 'sleeping')]
    return [...transition(sheets, 'start-sleep'), settleOn(sheets, 'sleeping')]
  }
  if (wasAwaiting === true) return [...transition(sheets, 'end-sleep'), loopOf(sheets.idle)]
  if (working) {
    if (wasWorking === true) return [settleOn(sheets, 'working')]
    return [...transition(sheets, 'start-working'), settleOn(sheets, 'working')]
  }
  if (wasWorking === true) return [...transition(sheets, 'end-working'), loopOf(sheets.idle)]
  return [loopOf(sheets.idle)]
}

/**
 * The single frame held for a viewer who asked for less movement (issue #71).
 *
 * Two choices, both inherited from the painted loops rather than reinvented.
 * It holds the clip the sequence SETTLES on, so a foreman is shown asleep and
 * not caught halfway to the floor; and within it the LAST frame, where the
 * gesture ends rather than where it winds up.
 */
export function stillFrameOf(clips: readonly SpriteClip[]): SequencePosition {
  const clip = clips.length - 1
  const sheet = clips[clip]?.sheet
  if (sheet === undefined) return { clip: 0, frame: 0 }
  return { clip, frame: Math.max(0, sheet.frames - 1) }
}
