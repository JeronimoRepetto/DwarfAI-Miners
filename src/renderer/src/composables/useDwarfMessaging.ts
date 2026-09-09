import { reactive } from 'vue'
import {
  REACTION_WINDOW_MS,
  observeReaction,
  openReactionWatch,
  type ReactionSnapshot,
  type ReactionWatch
} from '../lib/delivery/reaction'
import { boundEchoes, reconcileEchoes, type MessageEcho } from '../lib/message/echo'
import {
  defaultDwarfMessagingState,
  type Dwarf,
  type DwarfSendState,
  type DwarfTextResult,
  type FeedMessage
} from '../types'

/**
 * Delivery state for messages typed into the panel.
 *
 * Sending is deliberately fire-and-observe: the relay can take seconds, and
 * the panel must stay usable the whole time, so the only thing the UI blocks
 * on is the per-dwarf marker this store drives.
 *
 * The verdict has two phases (issue #21). 'delivered' means the text reached
 * the session's QUEUE — nothing more. A session reads its queue between tool
 * calls, so the store then watches that dwarf's own poll snapshots (fed in
 * through `observe`) for proof it acted, and only then promotes to 'reacted'.
 * A delivery that is never seen reacting decays back to a plain, honest
 * 'delivered' instead of hanging or claiming something that did not happen.
 *
 * ## Two records, and why the second one exists (#309)
 *
 * `state.byDwarfId` is one verdict per dwarf, and stays exactly that: it is
 * what the shell publishes to the mine so the marker on the dwarf's sprite
 * shows its LATEST delivery (see DwarfDeliveryReport). It cannot say which of
 * three messages failed, because a dwarf does not have three verdicts.
 *
 * The panel draws the person's words the instant Enter is pressed, so it needs
 * one record per MESSAGE. `echoes` is that: a bounded list per dwarf, keyed by
 * an id this store minted, each carrying the same `DwarfSendState` shape so
 * the bubble's tick and the sprite's marker are drawn from one reading of one
 * verdict (`sendMarker`). Every phase change below writes both — the same
 * verdict, twice, never two verdicts.
 */

/** How long a verdict stays on the dwarf before the marker clears itself. */
export const RESULT_VISIBLE_MS = 4_000

// Singleton store: module-scope state shared by every useDwarfMessaging()
// caller (house style shared with a sibling Vue project).
const state = reactive(defaultDwarfMessagingState())
/**
 * The messages the panel is drawing on the person's behalf, per dwarf, oldest
 * first (#309). Reactive because the panel renders straight off it; separate
 * from `state` because nothing about an echo crosses a process, and the wire
 * shape must not grow a renderer-only field.
 */
const echoes = reactive<Record<string, MessageEcho[]>>({})
const clearTimers = new Map<string, ReturnType<typeof setTimeout>>()
/** Open reaction watches, keyed by dwarf id — at most one per dwarf. */
const watches = new Map<string, ReactionWatch>()
const watchTimers = new Map<string, ReturnType<typeof setTimeout>>()
/**
 * Which MESSAGE the open watch belongs to, keyed by dwarf id.
 *
 * The watch is per dwarf, because the evidence is a dwarf's own snapshots; the
 * verdict it resolves belongs to the one message that opened it. Held
 * explicitly rather than assumed to be the newest echo: a promotion landing on
 * the wrong bubble would claim a reaction to words nobody reacted to.
 */
const watchedEchoId = new Map<string, string>()
/** The latest snapshot seen per dwarf, so a new delivery has a baseline to compare against. */
const lastSeen = new Map<string, ReactionSnapshot>()

/** Monotonic within the session, which is all an echo id has to be. */
let mintedEchoes = 0

function scheduleClear(dwarfId: string): void {
  clearTimeout(clearTimers.get(dwarfId))
  clearTimers.set(
    dwarfId,
    setTimeout(() => {
      delete state.byDwarfId[dwarfId]
      clearTimers.delete(dwarfId)
    }, RESULT_VISIBLE_MS)
  )
}

function stopWatch(dwarfId: string): void {
  clearTimeout(watchTimers.get(dwarfId))
  watchTimers.delete(dwarfId)
  watches.delete(dwarfId)
  watchedEchoId.delete(dwarfId)
}

/**
 * Write one message's own verdict, leaving every other message alone.
 *
 * Silent when the echo is gone — dropped by the cap, by the transcript
 * accounting for it, or by the panel moving to another dwarf. A verdict for a
 * bubble that is no longer drawn has nowhere to land, and the per-dwarf state
 * the sprite reads is written separately and still gets it.
 */
function markEcho(dwarfId: string, echoId: string, next: DwarfSendState): void {
  const list = echoes[dwarfId]
  if (list === undefined) return
  const index = list.findIndex((echo) => echo.id === echoId)
  if (index === -1) return
  list[index] = { ...list[index]!, state: next }
}

/**
 * Start watching for proof the session read this message. The marker deliberately
 * stays on screen for as long as the watch is open — the whole point is to show
 * whether a reaction followed, which a four-second ✓ could never do.
 */
function startWatch(dwarfId: string, echoId: string): void {
  stopWatch(dwarfId)
  watches.set(dwarfId, openReactionWatch('message', lastSeen.get(dwarfId), Date.now()))
  watchedEchoId.set(dwarfId, echoId)
  watchTimers.set(
    dwarfId,
    setTimeout(() => {
      stopWatch(dwarfId)
      const current = state.byDwarfId[dwarfId]
      if (current?.phase !== 'delivered') return
      // Decay, never promote: the window closed without proof, and the marker
      // says exactly that before clearing itself.
      const decayed: DwarfSendState = { ...current, awaitingReaction: false }
      state.byDwarfId[dwarfId] = decayed
      markEcho(dwarfId, echoId, decayed)
      scheduleClear(dwarfId)
    }, REACTION_WINDOW_MS)
  )
}

/**
 * Hand `text` to `dwarfId` and record both verdicts for it — the dwarf's, and
 * this one message's. The echo is minted BEFORE the await, which is the whole
 * feature: the bubble is on screen before any channel has been asked anything.
 */
async function deliver(dwarfId: string, text: string, pressEnter: boolean): Promise<boolean> {
  if (state.byDwarfId[dwarfId]?.phase === 'sending') return false
  clearTimeout(clearTimers.get(dwarfId))
  clearTimers.delete(dwarfId)
  stopWatch(dwarfId)
  state.byDwarfId[dwarfId] = { phase: 'sending' }

  const echoId = `echo-${++mintedEchoes}`
  const minted: MessageEcho = { id: echoId, text, sentAt: Date.now(), state: { phase: 'sending' } }
  echoes[dwarfId] = boundEchoes([...(echoes[dwarfId] ?? []), minted])

  let result: DwarfTextResult
  try {
    result = await window.api.sendDwarfText({ dwarfId, text, pressEnter })
  } catch {
    result = { delivered: false, via: 'none', error: 'The panel lost contact with the app.' }
  }

  const next: DwarfSendState = {
    phase: result.delivered ? 'delivered' : 'failed',
    via: result.via
  }
  if (result.error !== undefined) next.error = result.error
  if (result.delivered) next.awaitingReaction = true
  state.byDwarfId[dwarfId] = next
  markEcho(dwarfId, echoId, next)

  // A failure has nothing to wait for; a delivery does.
  if (result.delivered) startWatch(dwarfId, echoId)
  else scheduleClear(dwarfId)

  return result.delivered
}

export function useDwarfMessaging() {
  function stateFor(dwarfId: string): DwarfSendState | undefined {
    return state.byDwarfId[dwarfId]
  }

  /** The messages the panel is drawing for this dwarf, oldest first (#309). */
  function echoesFor(dwarfId: string): readonly MessageEcho[] {
    return echoes[dwarfId] ?? []
  }

  /**
   * Deliver `text` to `dwarfId`. A second call while one is still in flight
   * for the same dwarf is ignored: a double-click must never type the message
   * into a session twice.
   *
   * Resolves whether the delivery actually landed. App.vue's feed watch reads
   * this to decide whether to re-read the transcript (issue #183) — the
   * sending dwarf is always the one this panel has open, so a delivered send
   * is itself proof the tail may have moved, and that must not wait for the
   * ASSISTANT to speak next. The store's own `state.byDwarfId` is keyed by
   * dwarf id for the panel to render, not a channel for a caller to learn the
   * verdict of the one call it just made.
   */
  async function send(dwarfId: string, text: string, pressEnter: boolean): Promise<boolean> {
    return deliver(dwarfId, text, pressEnter)
  }

  /**
   * Send a message that failed again, from its own bubble (#309).
   *
   * A NEW echo, and the failed one is left exactly as it is. Two reasons, and
   * the second is the one that matters: a retry is a second delivery with its
   * own verdict, and reusing the failed bubble would erase the record that the
   * first attempt was made at all — which is the only thing on screen saying
   * the channel is unreliable.
   *
   * Refused for an id this store is not holding, which is the ordinary case
   * once the transcript has accounted for a message or the cap has dropped it.
   */
  async function retry(dwarfId: string, echoId: string): Promise<boolean> {
    const echo = echoes[dwarfId]?.find((candidate) => candidate.id === echoId)
    if (echo === undefined) return false
    // Always with the session's own Enter, exactly as the composer sends: the
    // retry is the same message, not a different kind of delivery.
    return deliver(dwarfId, echo.text, true)
  }

  /**
   * Fold one poll's snapshot of the mine into the store. This is the entire
   * input to reaction detection: the panel already receives every dwarf's
   * status and last message on each poll, so proving a session acted costs no
   * new IPC and no new main-process field.
   */
  function observe(dwarfs: readonly Dwarf[]): void {
    for (const dwarf of dwarfs) {
      const snapshot: ReactionSnapshot = { status: dwarf.status, lastMessage: dwarf.lastMessage }
      const watch = watches.get(dwarf.id)
      lastSeen.set(dwarf.id, snapshot)
      if (watch === undefined) continue

      const next = observeReaction(watch, snapshot, Date.now())
      if (next.verdict !== 'reacted') {
        watches.set(dwarf.id, next)
        continue
      }

      const echoId = watchedEchoId.get(dwarf.id)
      stopWatch(dwarf.id)
      const current = state.byDwarfId[dwarf.id]
      if (current?.phase !== 'delivered') continue
      const reacted: DwarfSendState = {
        phase: 'reacted',
        ...(current.via === undefined ? {} : { via: current.via })
      }
      state.byDwarfId[dwarf.id] = reacted
      if (echoId !== undefined) markEcho(dwarf.id, echoId, reacted)
      scheduleClear(dwarf.id)
    }
  }

  /**
   * Drop the messages this dwarf's transcript now accounts for (#309).
   *
   * Called with whatever wire messages the panel is drawing for that dwarf —
   * a held session's own conversation, or the observed tail — so the words the
   * transcript has arrive once rather than twice. The rule is
   * `lib/message/echo`'s; this is only where the answer is kept.
   */
  function reconcile(dwarfId: string, messages: readonly FeedMessage[]): void {
    const current = echoes[dwarfId]
    if (current === undefined || current.length === 0) return
    const kept = reconcileEchoes(current, messages)
    if (kept.length !== current.length) echoes[dwarfId] = kept
  }

  /**
   * Keep only this dwarf's messages, because it is the conversation on screen.
   *
   * An echo is the panel holding the person's words until the transcript takes
   * over; a panel that moved to another dwarf is no longer holding anything for
   * the one it left. Stated as "keep this one" rather than "forget that one" so
   * that a caller cannot forget to say which dwarf it left.
   */
  function keepEchoesFor(dwarfId: string | null): void {
    for (const id of Object.keys(echoes)) {
      if (id !== dwarfId) delete echoes[id]
    }
  }

  function clear(dwarfId: string): void {
    clearTimeout(clearTimers.get(dwarfId))
    clearTimers.delete(dwarfId)
    stopWatch(dwarfId)
    lastSeen.delete(dwarfId)
    delete state.byDwarfId[dwarfId]
    delete echoes[dwarfId]
  }

  function clearAll(): void {
    for (const dwarfId of Object.keys(state.byDwarfId)) clear(dwarfId)
    for (const dwarfId of [...watches.keys()]) stopWatch(dwarfId)
    for (const dwarfId of Object.keys(echoes)) delete echoes[dwarfId]
    lastSeen.clear()
  }

  return {
    state,
    echoes,
    send,
    retry,
    observe,
    reconcile,
    stateFor,
    echoesFor,
    keepEchoesFor,
    clear,
    clearAll
  }
}
