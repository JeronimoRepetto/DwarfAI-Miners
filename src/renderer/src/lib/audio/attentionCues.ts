/**
 * When an attention cue is due (#635): each one sounds once, as its state
 * BEGINS, and never for a state that merely persists across polls.
 *
 * Three beginnings, each read off a field the wire already carries and none
 * inferred:
 *
 * - `question` — a dwarf's `pendingQuestion` appears, or is replaced by an ask
 *   with another `toolUseId`. The same ask on the next poll is not a new one.
 * - `permission` — the same reading of `pendingPermission`.
 * - `finished` — a dwarf's `lastTurn` gains an `endedAt` it did not have. That
 *   field is the provider's own end-of-turn message (see TurnOutcome), never a
 *   silence this app measured, which is why a dwarf going quiet cues nothing:
 *   a turn that ended is a fact only its provider can state. Only a held
 *   session carries it today, so only a held session can cue it. A turn the
 *   user cancelled from the app (`cancelledFromApp`) is the one ending that
 *   cues nothing — the user already knows (PANEL-QUESTIONS Q24) — yet it is
 *   still SEEN, so the next genuine ending is judged against it.
 *
 * The FIRST observation is a baseline and answers nothing: an app that starts
 * with three dwarfs already asking has heard none of them begin, and chiming
 * three times at launch would be the panel claiming three new events. After
 * it, a dwarf seen for the first time is judged against nothing, so one that
 * arrives already asking cues — its arrival is where the ask began for us.
 *
 * Every kind is answered at most once per observation, in one fixed order,
 * because the engine holds one clip of a kind at a time: five dwarfs asking on
 * one poll is one question cue, not five cutting each other off.
 *
 * Pure bookkeeping and no sound: the caller hands the answer to the engine,
 * which applies the Notification sounds switch and the gates.
 */
import type { Dwarf, Mine } from '../../types'
import { ATTENTION_SFX_KINDS, type AttentionSfx } from './volume'

export interface AttentionWatch {
  /** Take one snapshot's mines; answer the cues that began since the last. */
  observe: (mines: readonly Mine[]) => AttentionSfx[]
}

/** What was last seen of one dwarf: the identity of each open state. */
interface Seen {
  question?: string
  permission?: string
  turnEndedAt?: number
}

function seenOf(dwarf: Dwarf): Seen {
  return {
    question: dwarf.pendingQuestion?.toolUseId,
    permission: dwarf.pendingPermission?.toolUseId,
    turnEndedAt: dwarf.lastTurn?.endedAt
  }
}

/** Whether a state is open now under an identity it did not have before. */
function began<T>(now: T | undefined, before: T | undefined): boolean {
  return now !== undefined && now !== before
}

export function createAttentionWatch(): AttentionWatch {
  /**
   * Keyed by dwarf id and REPLACED on every observation, so a dwarf that left
   * is forgotten rather than remembered for the rest of the run.
   */
  let seen: Map<string, Seen> | undefined

  return {
    observe(mines: readonly Mine[]): AttentionSfx[] {
      const next = new Map<string, Seen>()
      const due = new Set<AttentionSfx>()
      for (const mine of mines) {
        for (const dwarf of mine.dwarfs) {
          const now = seenOf(dwarf)
          next.set(dwarf.id, now)
          if (seen === undefined) continue
          const before = seen.get(dwarf.id) ?? {}
          if (began(now.question, before.question)) due.add('question')
          if (began(now.permission, before.permission)) due.add('permission')
          const cancelledFromApp = dwarf.lastTurn?.cancelledFromApp === true
          if (began(now.turnEndedAt, before.turnEndedAt) && !cancelledFromApp) {
            due.add('finished')
          }
        }
      }
      seen = next
      return ATTENTION_SFX_KINDS.filter((kind) => due.has(kind))
    }
  }
}
