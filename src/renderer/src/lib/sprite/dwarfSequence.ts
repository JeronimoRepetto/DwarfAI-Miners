/**
 * Which strips a dwarf plays, and in what order (issues #74, #87, #262, #306).
 *
 * ## The interruption rule
 *
 * A CHANGE OF STATE ALWAYS RESTARTS THE SEQUENCE, AND A TRANSITION CAUGHT
 * MID-PLAY IS ABANDONED WHERE IT STANDS. A foreman put back to work while he
 * is still lying down cuts straight to getting up; sent back to rest while
 * getting up cuts straight back to lying down. A worker sent home mid
 * pick-up cuts straight to setting the pick back down, never finishing the
 * swing it was caught starting.
 *
 * It is worth the sentence because the obvious alternative — letting a `once`
 * clip finish before honouring the new state — is what strands a sprite: two
 * quick changes and the drawing is a state behind the dwarf, with no bound on
 * how far behind it can fall. Here the clips are a pure function of two
 * independent (state, wasState) pairs — one for rest, one for working — so
 * the same four values always produce the same sequence however the dwarf
 * arrived at them, and there is no partial playback to unwind.
 *
 * The two pairs are independent in name only. `status` is a single field, so
 * a real dwarf is never `'waiting'` and `'working'` at once — but a dwarf CAN
 * carry a true past on one axis into a render where the other axis has since
 * gone true (rested, then put straight to work). Rest is checked first,
 * ahead of the working axis entirely, both for entering it and for the
 * transition OUT of it: leaving rest is always resolved before the working
 * axis is ever consulted. That ordering is what keeps a foreman's end-sleep
 * transition from being skipped the instant his status flips straight from
 * `'waiting'` to `'working'` — see `dwarfClips`'s own note below for why it
 * has to be exactly this way round.
 *
 * ## Rest is a status, not a proven reason (issue #306)
 *
 * The sleep axis used to be keyed on `isAwaitingAnswer` — true only where a
 * provider PROVED a human was asked something (`waitingReason ===
 * 'user-input'`, issue #60). That disagreed with `DwarfStatusIcons`' own
 * sleep marker, which has always drawn for `status === 'waiting'` alone: a
 * foreman resting at his prompt with no proven reason was marked asleep by
 * the glyph and drawn awake by the sequence. `isResting` below is exactly the
 * marker's own predicate, exported so the sequence's caller can never compute
 * a different answer than the glyph does. #60's normalized reason has not
 * gone anywhere — it still drives its own glyph, the important-dialog mark on
 * `dwarf.pendingQuestion` — it just no longer decides which SEQUENCE plays.
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
 * dwarf is in — the sleep marker still marks a resting one and the leaving
 * fade still marks a departure — but the SPRITE says it only where the art
 * exists.
 *
 * ## Arrival gates the working sequence (issue #262)
 *
 * #74 ruled that STATUS ALONE decided the sheet, so a dwarf already
 * `working` played its swing while still crossing the floor to it — the
 * "walking" case above meant only "no walk strip has been drawn", never
 * "still travelling". #262 reverses that ruling: a dwarf that is walking
 * plays its IDLE sequence, whatever its status, and the working sequence
 * only begins on arrival. This was always true of the strike's own sparks
 * and glow (`DwarfSprite.vue` already refuses both mid-walk); the sequence
 * was the one thing left contradicting the scene. See `dwarfClips`'s own
 * note below for what this does to `wasWorking`'s meaning.
 */
import type { DwarfRole, DwarfStatus } from '../../types'
import { DWARF_SHEETS, type DwarfSheetName, type DwarfSheetSet } from './dwarfSheets'
import { loopOf, onceOf, type SequencePosition, type SpriteClip } from './spriteSheet'

/**
 * Whether this dwarf is resting (issue #306) — the exact predicate
 * `DwarfStatusIcons`' own sleep marker draws for (`DwarfSprite.vue`'s
 * `:resting` binding), so the marker and the sequence can never disagree
 * again. It replaces `isAwaitingAnswer`, which read `waitingReason` and
 * required a provider to have PROVED a human was asked something (#60) —
 * exactly the reason a foreman resting with no such proof was marked asleep
 * and drawn awake. Rest is a status, not a reason, and this reads only the
 * one field both the marker and the sequence already agreed meant it.
 */
export function isResting(status: DwarfStatus): boolean {
  return status === 'waiting'
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
 * `wasResting` and `wasWorking` are the PREVIOUS answers on each axis, which
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
 * `arrived` defaults to `true` for the same reason: every call site written
 * before issue #262 has nothing to say about travel and must keep meaning
 * exactly what it always did. ARRIVAL, not status, gates entry to the
 * working sequence — a dwarf that is `working` but has not arrived (`arrived`
 * false) idles, full stop, whatever `wasWorking` says.
 *
 * That gate changes what `wasWorking` has to mean: it is no longer "was the
 * status `working` last render", it is "was the working sequence actually
 * being SHOWN last render" (the caller carries this the same way it always
 * has — as the previous answer on the axis, see the note above). A dwarf
 * that carries a `working` status through an entire walk never sets it, so
 * arriving reads as a fresh start — the same pick-up a dwarf gets for
 * beginning work while already standing still, not a mid-swing resume — and
 * a dwarf whose status stops being `working` while it was still walking
 * never earns an end-working transition either, because the walk meant it
 * was never shown starting one. Walking away from a dwarf that WAS shown
 * working is the mirror case, and gets the ordinary end-working abandonment,
 * by the same interruption rule as everything else in this file.
 *
 * The branch order is load-bearing, not incidental: REST is checked first
 * (current, then its exit) and the working axis only after both. A dwarf can
 * never be CURRENTLY both — `status` is one field, so `resting` and `working`
 * can never both be true for the same render — so the first `if` is a plain
 * priority pick when it happens to fire. What the order actually protects is
 * the SECOND `if`: without it running before the working checks, a foreman
 * whose status flips straight from `'waiting'` to `'working'` would have his
 * end-sleep transition skipped, because `working` would already be true on
 * that very render. Sleep finishing what it started always comes before work
 * gets a say.
 */
export function dwarfClips(
  role: DwarfRole,
  resting: boolean,
  wasResting: boolean | undefined,
  working = false,
  wasWorking: boolean | undefined = undefined,
  arrived = true
): readonly SpriteClip[] {
  const sheets = DWARF_SHEETS[role]
  if (resting) {
    if (wasResting === true) return [settleOn(sheets, 'sleeping')]
    return [...transition(sheets, 'start-sleep'), settleOn(sheets, 'sleeping')]
  }
  if (wasResting === true) return [...transition(sheets, 'end-sleep'), loopOf(sheets.idle)]
  // Arrival gates the working sequence (#262): a dwarf still walking never
  // shows it, whatever its status — see the note above.
  const atWork = working && arrived
  if (atWork) {
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
