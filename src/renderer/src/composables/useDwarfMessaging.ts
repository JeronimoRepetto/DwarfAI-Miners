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
  type DwarfAttachment,
  type DwarfSendSettledPush,
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
/**
 * The files each echo was sent with, keyed by dwarf id then echo id (#408).
 *
 * A SIBLING of `echoes` rather than a field on `MessageEcho`, and deliberately:
 * that shape belongs to `lib/message/echo`, whose subject is reconciling the
 * panel's own bubbles against the transcript — a job attachments play no part
 * in, since the transcript row that supersedes an echo is matched on its words.
 * Keeping them apart also means an echo dropped by the cap or by reconciliation
 * takes its attachments with it through the same three lines that drop the echo,
 * which is why every deletion below writes both.
 *
 * What it is FOR is the two things the design asks of a sent message: the
 * person's own bubble shows the chips it was sent with, and `Send again`
 * resends them with the words (#309).
 */
const echoAttachments = reactive<Record<string, Record<string, readonly DwarfAttachment[]>>>({})
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
/**
 * Which bubble each message main is HOLDING belongs to, keyed by the hold id
 * main minted (#457).
 *
 * A third record beside the two above, and it exists for the reason the second
 * one does: a dwarf can have several messages waiting at once, so neither the
 * dwarf id nor "the newest echo" can say which of them a verdict arriving
 * minutes later is about. Main is the one that mints the id, because main is
 * the one holding the queue — see `DwarfSendSettledPush`.
 */
const heldMessages = new Map<string, { dwarfId: string; echoId: string }>()

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
 * Forget the attachments of every echo this dwarf no longer has (#408).
 *
 * The one place that happens, called wherever `echoes[dwarfId]` is rewritten:
 * the cap dropping the oldest, and the transcript accounting for a message. A
 * map that outlived its echoes would hold a data-URL thumbnail for a bubble
 * nobody can see any more.
 */
function pruneAttachments(dwarfId: string): void {
  const held = echoAttachments[dwarfId]
  if (held === undefined) return
  const live = new Set((echoes[dwarfId] ?? []).map((echo) => echo.id))
  const kept = Object.fromEntries(Object.entries(held).filter(([id]) => live.has(id)))
  if (Object.keys(kept).length === 0) delete echoAttachments[dwarfId]
  else echoAttachments[dwarfId] = kept
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
 * A copy of `attachment` holding exactly the contract's four wire fields, and
 * nothing this composable happens to be storing it in (#417).
 *
 * `pending` in the composer is a `ref<readonly DwarfAttachment[]>`, which Vue
 * makes deeply reactive: the array and every attachment in it are `Proxy`
 * objects. `window.api.sendDwarfText` is `ipcRenderer.invoke`, which
 * serialises its arguments with the structured clone algorithm — the same
 * algorithm Node's own `structuredClone` runs — and a `Proxy` cannot be
 * cloned, so the call threw `DataCloneError` before anything reached main.
 * The renderer must send what the wire says and nothing it happens to hold,
 * regardless of Vue: this is that copy, made right before the boundary.
 */
function plainAttachment(attachment: DwarfAttachment): DwarfAttachment {
  return {
    path: attachment.path,
    name: attachment.name,
    kind: attachment.kind,
    bytes: attachment.bytes
  }
}

/**
 * Hand `text` to `dwarfId` and record both verdicts for it — the dwarf's, and
 * this one message's. The echo is minted BEFORE the await, which is the whole
 * feature: the bubble is on screen before any channel has been asked anything.
 */
async function deliver(
  dwarfId: string,
  text: string,
  pressEnter: boolean,
  attachments: readonly DwarfAttachment[] = []
): Promise<boolean> {
  if (state.byDwarfId[dwarfId]?.phase === 'sending') return false
  clearTimeout(clearTimers.get(dwarfId))
  clearTimers.delete(dwarfId)
  stopWatch(dwarfId)
  state.byDwarfId[dwarfId] = { phase: 'sending' }

  const echoId = `echo-${++mintedEchoes}`
  const minted: MessageEcho = { id: echoId, text, sentAt: Date.now(), state: { phase: 'sending' } }
  echoes[dwarfId] = boundEchoes([...(echoes[dwarfId] ?? []), minted])
  if (attachments.length > 0) {
    echoAttachments[dwarfId] = { ...echoAttachments[dwarfId], [echoId]: attachments }
  }
  pruneAttachments(dwarfId)

  // Plain objects, never the reactive ones the composer happens to be
  // holding (#417) — see plainAttachment.
  const wireAttachments = attachments.map(plainAttachment)

  let result: DwarfTextResult
  try {
    result = await window.api.sendDwarfText({
      dwarfId,
      text,
      pressEnter,
      // Omitted rather than sent empty, so a text-only message is the exact
      // payload every caller sent before #408.
      ...(wireAttachments.length === 0 ? {} : { attachments: wireAttachments })
    })
  } catch {
    result = { delivered: false, via: 'none', error: 'The panel lost contact with the app.' }
  }

  // Main is HOLDING this one for a busy Codex thread (#457): it answered at
  // once, and what it answered is that nothing has been sent. So the verdict
  // below is not taken at all — the marker says waiting, the bubble is
  // remembered under main's own hold id, and the real verdict arrives on
  // `settle` when the turn the message is waiting for ends.
  //
  // Neither `startWatch` nor `scheduleClear` runs here, and both absences are
  // deliberate: there is no hand-over for a session to be seen reacting to,
  // and a marker that cleared itself after four seconds would leave the person
  // believing the message had gone.
  const holdId = result.holdId
  if (holdId !== undefined) {
    const waiting: DwarfSendState = { phase: 'held', via: result.via }
    state.byDwarfId[dwarfId] = waiting
    markEcho(dwarfId, echoId, waiting)
    heldMessages.set(holdId, { dwarfId, echoId })
    return false
  }

  return recordVerdict(dwarfId, echoId, result)
}

/**
 * Write one message's verdict onto both records, and start whatever that
 * verdict has left to wait for.
 *
 * Shared by the send itself and by a held message settling minutes later
 * (#457), because they are the same verdict: a second spelling here is how the
 * held path would come to draw a ✓ on terms the live one never would.
 */
function recordVerdict(dwarfId: string, echoId: string, result: DwarfTextResult): boolean {
  // A relay courier killed by its own timeout (#439) is neither a proven
  // delivery nor a proven failure — see DwarfTextResult.unconfirmed — and it
  // must not draw as the latter: a ✕ with `Send again` risks handing the same
  // words to the session twice. So it takes the 'delivered' phase, exactly
  // like a confirmed one, carrying the flag that tells the marker and the
  // status line to say so rather than to claim a hand-over this app never saw
  // confirmed.
  const unconfirmed = !result.delivered && result.unconfirmed === true
  const next: DwarfSendState = {
    phase: result.delivered || unconfirmed ? 'delivered' : 'failed',
    via: result.via
  }
  if (result.error !== undefined) next.error = result.error
  if (result.delivered || unconfirmed) next.awaitingReaction = true
  if (unconfirmed) next.unconfirmed = true
  state.byDwarfId[dwarfId] = next
  markEcho(dwarfId, echoId, next)

  // A failure has nothing to wait for; a delivery does — and an unconfirmed
  // relay decays exactly like one, per DwarfSendState.unconfirmed.
  if (result.delivered || unconfirmed) startWatch(dwarfId, echoId)
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
  async function send(
    dwarfId: string,
    text: string,
    pressEnter: boolean,
    attachments: readonly DwarfAttachment[] = []
  ): Promise<boolean> {
    return deliver(dwarfId, text, pressEnter, attachments)
  }

  /**
   * What finally happened to a message main was holding (#457) — main's own
   * push, applied to the one bubble it names.
   *
   * Silent for an id this store is not holding, which is the ordinary case
   * once the panel has moved to another dwarf or this window has been
   * reopened: a verdict with nowhere to land must not invent a marker for a
   * message nobody can see.
   *
   * The verdict goes through `recordVerdict`, so a held message that finally
   * delivered opens the same reaction watch a live one does — nothing about a
   * ✓ here is weaker for having waited.
   */
  function settle(push: DwarfSendSettledPush): void {
    const held = heldMessages.get(push.holdId)
    if (held === undefined) return
    heldMessages.delete(push.holdId)
    recordVerdict(held.dwarfId, held.echoId, push.result)
  }

  /** Hear main's held-message verdicts. Returns the unsubscribe. */
  function listenHeld(): () => void {
    return window.api.onDwarfSendSettled(settle)
  }

  /** The files one sent message carried, for its own bubble and its retry (#408). */
  function attachmentsFor(dwarfId: string, echoId: string): readonly DwarfAttachment[] {
    return echoAttachments[dwarfId]?.[echoId] ?? []
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
    // retry is the same message, not a different kind of delivery — which since
    // #408 includes its files. Read BEFORE the new echo is minted, because
    // minting one can prune this map.
    const attachments = echoAttachments[dwarfId]?.[echoId] ?? []
    return deliver(dwarfId, echo.text, true, attachments)
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
   *
   * `echoAttachments[dwarfId]` rides along (#419) so an echo sent with files
   * can be accounted for too — a row for it carries their tokens ahead of the
   * words, and `reconcileEchoes` is what reads them off keyed by echo id.
   */
  function reconcile(dwarfId: string, messages: readonly FeedMessage[]): void {
    const current = echoes[dwarfId]
    if (current === undefined || current.length === 0) return
    const kept = reconcileEchoes(current, messages, echoAttachments[dwarfId] ?? {})
    if (kept.length === current.length) return
    echoes[dwarfId] = kept
    pruneAttachments(dwarfId)
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
    for (const id of Object.keys(echoAttachments)) {
      if (id !== dwarfId) delete echoAttachments[id]
    }
  }

  function clear(dwarfId: string): void {
    clearTimeout(clearTimers.get(dwarfId))
    clearTimers.delete(dwarfId)
    stopWatch(dwarfId)
    lastSeen.delete(dwarfId)
    delete state.byDwarfId[dwarfId]
    delete echoes[dwarfId]
    delete echoAttachments[dwarfId]
    // #457. The bubbles these named are gone, so their verdicts have nowhere
    // to land; main goes on holding the messages themselves either way, which
    // is where they were always kept.
    for (const [holdId, held] of heldMessages) {
      if (held.dwarfId === dwarfId) heldMessages.delete(holdId)
    }
  }

  function clearAll(): void {
    for (const dwarfId of Object.keys(state.byDwarfId)) clear(dwarfId)
    for (const dwarfId of [...watches.keys()]) stopWatch(dwarfId)
    for (const dwarfId of Object.keys(echoes)) delete echoes[dwarfId]
    for (const dwarfId of Object.keys(echoAttachments)) delete echoAttachments[dwarfId]
    lastSeen.clear()
    heldMessages.clear()
  }

  return {
    state,
    echoes,
    echoAttachments,
    attachmentsFor,
    send,
    settle,
    listenHeld,
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
