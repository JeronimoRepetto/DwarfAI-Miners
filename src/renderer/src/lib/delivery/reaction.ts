import type { DwarfStatus } from '../../types'

/**
 * Turning "delivered" into an honest verdict (issue #21).
 *
 * `delivered: true` means one thing only: the relay process exited 0, i.e. the
 * message was handed to the target session's QUEUE. A session reads its queue
 * between tool calls, so the visible reaction can lag by a long time — the ✓
 * was overstating what actually happened.
 *
 * This module closes that gap without any new IPC: the panel already receives a
 * fresh snapshot of every dwarf on each poll, so a delivery can simply watch
 * that dwarf's own status/message stream for the transition that PROVES the
 * session acted. Pure and snapshot-fed on purpose — the composables own the
 * timers, this owns the judgement.
 *
 * The rule everywhere below: when in doubt, stay pending. A marker that
 * wrongly claims a reaction is worse than one that admits it never saw one.
 */

/** What a delivery is waiting to see proof of. */
export type ReactionKind = 'kick' | 'message'

/** The slice of a dwarf snapshot that can prove a session reacted. */
export interface ReactionSnapshot {
  status: DwarfStatus
  lastMessage?: string
}

/**
 * pending: still watching. reacted: the session provably acted. expired: the
 * bounded window closed without proof — the delivery decays back to plain
 * "handed over", never to a claimed reaction.
 */
export type ReactionVerdict = 'pending' | 'reacted' | 'expired'

/**
 * How long a delivery keeps watching for its reaction. A minute comfortably
 * covers a relay turn (5-20s) plus a session finishing the tool call it was
 * inside, and is short enough that a marker can never outlive its usefulness on
 * screen. Past it the delivery stays honestly "handed over, no reaction seen".
 */
export const REACTION_WINDOW_MS = 60_000

export interface ReactionWatch {
  readonly kind: ReactionKind
  readonly verdict: ReactionVerdict
  readonly openedAt: number
  /**
   * The snapshot every later one is compared against. Undefined when the
   * delivery fired before any snapshot arrived; the first observed snapshot
   * then becomes the baseline rather than being read as a change.
   */
  readonly baseline: ReactionSnapshot | undefined
  /**
   * Whether the session has been seen working at any point during the watch.
   * A kick delivered to an already-idle session has no working->waiting edge to
   * catch, so the proof is the full round trip: it wakes to read the kick, then
   * settles again.
   */
  readonly sawWorking: boolean
}

export function openReactionWatch(
  kind: ReactionKind,
  baseline: ReactionSnapshot | undefined,
  openedAt: number
): ReactionWatch {
  return {
    kind,
    verdict: 'pending',
    openedAt,
    baseline,
    sawWorking: baseline?.status === 'working'
  }
}

/**
 * A kick asks the session to stop. The proof is that it stopped: a transition
 * into 'waiting' from a turn we actually saw running.
 *
 * 'leaving' is deliberately NOT proof. It means the agent finished or vanished,
 * which is exactly as consistent with a crash or a normal exit as with the kick
 * landing, and the marker must not claim credit for it.
 */
function kickReacted(watch: ReactionWatch, snapshot: ReactionSnapshot): boolean {
  return watch.sawWorking && snapshot.status === 'waiting'
}

/**
 * A message is proven read when the session either produced new output or
 * picked up a turn it was not running before.
 *
 * working -> waiting is deliberately NOT proof: it only says the turn that was
 * ALREADY running ended, which is what happens right before a queued message is
 * read, not evidence that it was.
 */
function messageReacted(baseline: ReactionSnapshot, snapshot: ReactionSnapshot): boolean {
  if (snapshot.lastMessage !== baseline.lastMessage) return true
  return baseline.status === 'waiting' && snapshot.status === 'working'
}

/**
 * Fold one poll snapshot into a watch. `snapshot` is undefined when the dwarf
 * is not in this poll at all — that is not proof of anything either, so the
 * watch simply keeps waiting until its window closes.
 */
export function observeReaction(
  watch: ReactionWatch,
  snapshot: ReactionSnapshot | undefined,
  at: number,
  windowMs: number = REACTION_WINDOW_MS
): ReactionWatch {
  // A reaction, once observed, is a fact — later polls cannot take it back.
  if (watch.verdict === 'reacted') return watch
  if (at - watch.openedAt >= windowMs) return { ...watch, verdict: 'expired' }
  if (snapshot === undefined) return { ...watch }

  const sawWorking = watch.sawWorking || snapshot.status === 'working'

  // Nothing to compare against yet: adopt this snapshot as the reference
  // instead of reading it as a change that already happened.
  if (watch.baseline === undefined) {
    return { ...watch, baseline: snapshot, sawWorking }
  }

  const reacted =
    watch.kind === 'kick'
      ? kickReacted({ ...watch, sawWorking }, snapshot)
      : messageReacted(watch.baseline, snapshot)

  return {
    ...watch,
    sawWorking,
    verdict: reacted ? 'reacted' : 'pending'
  }
}
