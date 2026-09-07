<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AddPanel from './components/launch/AddPanel.vue'
import DwarfMessagePanel from './components/message/DwarfMessagePanel.vue'
import { useAgentLaunch } from './composables/useAgentLaunch'
import { useDwarfKicking } from './composables/useDwarfKicking'
import { useDwarfMessaging } from './composables/useDwarfMessaging'
import { useDwarfQuestion } from './composables/useDwarfQuestion'
import { useMessagePanel } from './composables/useMessagePanel'
import { useMines } from './composables/useMines'
import { shouldHidePanelAfterActivation } from './lib/delivery/activation'
import type {
  Dwarf,
  DwarfFeedResult,
  DwarfKickState,
  DwarfPermissionDecision,
  DwarfSendState,
  Mine,
  MinesSnapshot,
  WatchedFeedPush
} from './types'

/**
 * The message panel's own window (#162).
 *
 * The design draws this surface beside the shell rather than inside it — in
 * `assets/mine/mine-and-message-panel.png` the panel occupies its own region
 * of the desktop with an untouched mine to its side — so it is a second
 * BrowserWindow, loaded from the same page with `?surface=message-panel` and
 * rooted here instead of in App.vue.
 *
 * ## What it owns, and why that is not the shell's job any more
 *
 * Everything about the conversation: the two panels that share this one slot
 * (the Add Panel is REPLACED by the MessagePanel when a launch is submitted,
 * which is the design's own transition), the observed session's transcript,
 * the send, the kick, the answers, and the launch. It holds them because it
 * DOES them — a surface whose state lived in the other window would need every
 * keystroke of a prompt to make two process hops.
 *
 * Two things travel back to the shell, and only two. What this window is open
 * on, so the mine can draw the selected dwarf's red halo — through the state
 * main holds for both windows (see useMessagePanel). And the delivery verdicts,
 * because the marker they drive is drawn on the dwarf's own sprite, inside the
 * mine, which is over there (see useDwarfDelivery).
 *
 * ## Its own height is the window's height
 *
 * The design's four sizing rules stay exactly where they were, in
 * `lib/message/panelHeight`: the height derives from the latest message when
 * the panel opens, new messages do not resize it, reopening recalculates, and
 * the user may drag it vertically only. What changed is where the answer goes —
 * this window measures the surface it drew and reports it, and main gives the
 * WINDOW that height. Which is also what makes "vertically only" true of the
 * window rather than merely intended by the component: main owns the width.
 */

const { state, setMines } = useMines()
const { state: messagingState, send: sendDwarfText, observe: observeSends } = useDwarfMessaging()
const { state: kickingState, kick, observe: observeKicks } = useDwarfKicking()
const {
  state: questionState,
  answer: answerDwarfQuestion,
  decide: decideDwarfPermission
} = useDwarfQuestion()

/**
 * Which surface this window has been asked for, held by MAIN so that both
 * windows read one answer (see MessagePanelState). Written from here too: this
 * window closes itself, and it is the one that learns which dwarf a launch
 * turned out to have started.
 */
const {
  state: panel,
  sync: syncPanel,
  listen: listenPanel,
  openMessage,
  close: closePanel
} = useMessagePanel()

/**
 * Launching an agent from inside a mine (#86). This window owns the composable
 * — and therefore the bridge — because it owns the DOCK: the Add Panel and the
 * MessagePanel share one slot, which is the design's own transition, so which
 * of them is drawn cannot be decided by either.
 */
const {
  state: launchState,
  mineId: launchMineId,
  chips: launchChips,
  phase: launchPhase,
  enabled: launchEnabled,
  placeholder: launchPlaceholder,
  refusal: launchRefusal,
  open: openLaunchPanel,
  close: closeLaunchPanel,
  choose: chooseProvider,
  setCommand: setLaunchCommand,
  commit: commitLaunchCommand,
  setPrompt: setLaunchPrompt,
  submit: submitLaunch,
  observe: observeLaunch
} = useAgentLaunch()

const error = ref<string | null>(null)

/** The mine this window's surface belongs to, as the current snapshot reports it. */
const currentMine = computed<Mine | undefined>(() =>
  state.mines.find((mine) => mine.id === panel.value.mineId)
)

/** The dwarf the shell asked this window to open on, or none. */
const askedDwarfId = computed<string | null>(() =>
  panel.value.surface === 'message' && panel.value.dwarfId !== '' ? panel.value.dwarfId : null
)

/**
 * The dwarf the message panel is actually open on: the one the shell named, or
 * the one a launch turned out to have started (#86).
 *
 * DERIVED rather than assigned, and that is the whole point. The design's
 * transition is the Add Panel being replaced by the MessagePanel on the new
 * dwarf, which reads like a moment to react to — but a handover carried out by
 * a watcher is a handover that can be missed. Reading it is a statement that
 * stays true however many times it is read.
 */
const openDwarfId = computed(() => launchState.value.launchedDwarfId ?? askedDwarfId.value)

/**
 * The transcript read for the open dwarf, for a session this panel only
 * OBSERVES. `undefined` means the read has not come back — which the panel
 * says out loud rather than drawing as an empty conversation.
 */
const selectedFeed = ref<DwarfFeedResult | undefined>(undefined)
/** Which read is the current one, so a slow answer cannot land on a later dwarf. */
let feedToken = 0
/**
 * Which dwarf `selectedFeed` currently answers for — so a re-read for that
 * SAME dwarf can leave the previous result on screen while it is in flight,
 * and only a genuine switch (or a skip) clears it back to `undefined` (#195).
 * `null` is "nobody's, blank it on the next read", which is also the reset a
 * held session or a closed panel leaves behind.
 */
let selectedFeedDwarfId: string | null = null

/**
 * The signal a pushed `watchedFeed` last satisfied (#196), so the re-read
 * watch below can tell "this exact change already arrived with its feed"
 * apart from "this is a change nothing has answered yet" — the same two
 * fields that watch itself keys on, folded into one string. Left stale after
 * use rather than cleared: a LATER change always produces a different key, so
 * it still pulls exactly as it did before this feature existed.
 */
let pushedFeedSignal: string | null = null

/** The composite key both the push-adoption and the pull-watch compare (#196). */
function watchedFeedSignalKey(dwarfId: string, dwarf: Dwarf | undefined): string {
  return `${dwarfId}|${dwarf?.lastMessage ?? ''}|${dwarf?.transcriptUpdatedAt ?? ''}`
}

/**
 * Adopt a feed main pushed with this snapshot (#196), when it is for the
 * dwarf currently open. A push for a dwarf this panel is no longer on (or
 * never was) is ignored, exactly as a stale getDwarfFeed answer already is
 * (see feedToken) — the panel only ever shows a feed for what is open now.
 *
 * Bumps `feedToken` so an unrelated pull already in flight for this same
 * dwarf cannot land after this and clobber it with a stale answer, and
 * records the signal this push satisfied so the re-read watch below does not
 * also fire a redundant pull for the very same change.
 */
function adoptWatchedFeed(watchedFeed: WatchedFeedPush | undefined): void {
  if (watchedFeed === undefined || watchedFeed.dwarfId !== openDwarfId.value) return
  feedToken++
  replaceSelectedFeed(watchedFeed.dwarfId, watchedFeed.feed, 'push')
  pushedFeedSignal = watchedFeedSignalKey(watchedFeed.dwarfId, selectedDwarf.value)
}

/**
 * Every replacement of `selectedFeed` goes through here (#249), so the one
 * failure nobody has been able to explain — a panel that lost the words it
 * was showing while its dwarf stayed live — leaves a line in the dev console
 * naming which of the two paths did it. Logged only on a LOSS for the same
 * dwarf: fewer messages than the feed it replaces, or one that stopped being
 * readable. A feed that grows is the ordinary case and stays silent, and a
 * change of dwarf is a first read rather than a loss.
 */
function replaceSelectedFeed(dwarfId: string, next: DwarfFeedResult, via: 'push' | 'pull'): void {
  if (import.meta.env.DEV) {
    const previous = selectedFeed.value
    const lost =
      previous !== undefined &&
      selectedFeedDwarfId === dwarfId &&
      (next.messages.length < previous.messages.length || (previous.readable && !next.readable))
    if (lost) {
      console.warn(
        `[panel] feed for ${dwarfId} shrank via ${via}: ${previous.messages.length} -> ${next.messages.length}, readable=${next.readable}`
      )
    }
  }
  selectedFeedDwarfId = dwarfId
  selectedFeed.value = next
}

function update(snapshot: MinesSnapshot): void {
  setMines(snapshot)
  // A launch in flight is watching for its own dwarf, which arrives on an
  // ordinary poll like every other session's — this is that poll.
  observeLaunch(snapshot.mines)
  // The one dwarf's feed main re-read on the SAME pass (#196), read here
  // AFTER setMines so `selectedDwarf` already reflects this snapshot.
  adoptWatchedFeed(snapshot.watchedFeed)
}

async function load(): Promise<void> {
  try {
    update(await window.api.getMines())
  } catch {
    // The board is the only thing this window reads from main that it cannot
    // do without: with no snapshot there is no dwarf to draw a panel for, and
    // the next push corrects it.
  }
}

/**
 * Every poll's whole board, folded into the two delivery stores (#21).
 *
 * It used to be MineScene doing this, from the crew of the one mine it drew.
 * The stores live HERE now, because this window is the one that sends and
 * kicks — and a watch for a reaction can only be resolved where it was opened.
 * Every dwarf rather than one mine's crew, too: a session whose mine closed
 * still deserves the verdict of the message somebody sent it.
 *
 * Not a deep watch: `setMines` replaces the whole list on every poll, so the
 * reference changes each time and a deep traversal of every mine and every
 * dwarf would be paid twice a second for a fact the identity already carries.
 */
watch(
  () => state.mines,
  (mines) => {
    const dwarfs = mines.flatMap((mine) => mine.dwarfs)
    observeSends(dwarfs)
    observeKicks(dwarfs)
  },
  { immediate: true }
)

/** The open dwarf as the CURRENT snapshot reports it, or nothing once the board dropped it. */
const liveSelectedDwarf = computed<Dwarf | undefined>(() =>
  openDwarfId.value === null
    ? undefined
    : currentMine.value?.dwarfs.find((dwarf) => dwarf.id === openDwarfId.value)
)

/**
 * The open dwarf as the board LAST reported it (#192).
 *
 * The panel used to exist only while its dwarf was in the live snapshot, so a
 * session ending — the moment its final reply lands — unmounted the panel and
 * lost the conversation. Main already keeps a finished dwarf on the board as
 * 'leaving' for a grace window, and then drops it; this holds on to that last
 * snapshot so the panel can outlive the drop and be closed by the person.
 *
 * Every real disappearance passes through 'leaving' (see DwarfLifecycleTracker),
 * so the kept dwarf already carries the status the panel reads as "ended". The
 * stamp below is for a board that drops a dwarf without that window — it says
 * the same thing the tracker would have, and nothing the snapshot did not.
 */
const lastSelectedDwarf = ref<Dwarf | undefined>(undefined)

watch(liveSelectedDwarf, (dwarf, previous) => {
  if (dwarf !== undefined) {
    lastSelectedDwarf.value = dwarf
    return
  }
  if (previous !== undefined) lastSelectedDwarf.value = { ...previous, status: 'leaving' }
})

const selectedDwarf = computed<Dwarf | undefined>(() => {
  if (liveSelectedDwarf.value !== undefined) return liveSelectedDwarf.value
  const last = lastSelectedDwarf.value
  return last !== undefined && last.id === openDwarfId.value ? last : undefined
})

/**
 * Whether the Add Panel is what this window is drawing.
 *
 * The launch's own phase decides, not the state main holds: the design's
 * transition keeps the launch surface on screen through the spawn — the chips
 * and the composer go, the submitted prompt stays — and only `launchArrival`
 * knows when the handover is complete. So the state saying 'message' does not
 * pull the Add Panel out from under a launch that is still spawning.
 */
const launchOpen = computed(
  () => launchPhase.value !== 'closed' && launchPhase.value !== 'message-panel'
)

/**
 * Follow the surface main was asked for.
 *
 * Opening the launch panel is guarded on it not already being open for this
 * mine, for the reason App's own Add action was: `open()` starts a FRESH panel,
 * so a repeated state — the shell re-publishing, a push arriving after the
 * pull — would silently discard a prompt somebody was half-way through typing.
 */
watch(
  () => [panel.value.surface, panel.value.mineId] as const,
  ([surface, mineId]) => {
    if (surface === 'launch') {
      if (launchMineId.value === mineId && launchPhase.value !== 'closed') return
      void openLaunchPanel(mineId)
      return
    }
    // Anything else closes the launch: a dwarf was selected instead, the mine
    // went away, or the window was closed. The session itself is untouched
    // either way — closing the panel only lets go of the handover.
    if (launchPhase.value !== 'closed') closeLaunchPanel()
  },
  { immediate: true }
)

/**
 * Tell the shell which dwarf a launch turned out to have started, so the mine
 * can draw its halo on the right sprite (#86, #162).
 *
 * This window is the only one that can know: the handover is decided by the
 * launch's own arrival rules, from the board, here. Published as the ordinary
 * message surface, which is what it now is.
 */
watch(
  () => launchState.value.launchedDwarfId,
  (dwarfId) => {
    if (dwarfId === null || currentMine.value === undefined) return
    if (panel.value.surface === 'message' && panel.value.dwarfId === dwarfId) return
    void openMessage(currentMine.value.id, dwarfId)
  }
)

/**
 * (Re-)read the open dwarf's transcript tail, for a session this panel only
 * observes.
 *
 * Bumps feedToken first, so an answer already in flight — from the watch
 * below, or from an earlier call here — cannot land after a fresher one has
 * started; only the newest token's answer is ever kept (issue #183: the
 * panel's own send is now a second caller of this, beside the watch).
 *
 * Blanks `selectedFeed` first only when this is the FIRST read for `dwarfId`
 * — a change of dwarf, or the very first read after the panel opened. A
 * re-read for the dwarf `selectedFeed` already answers for leaves the
 * previous result on screen while this one is in flight (the maintainer's
 * follow-up on #195): the poll re-reads on every sign of activity, so blanking
 * unconditionally rebuilt the row list from nothing on EVERY tick, not only
 * the first one, which is what made a busy session's panel look frozen — rows
 * arrive below the fold while the list snaps back to empty and then to the
 * top before the same words reappear a moment later.
 */
async function readSelectedFeed(dwarfId: string): Promise<void> {
  const token = ++feedToken
  const isFirstRead = selectedFeedDwarfId !== dwarfId
  selectedFeedDwarfId = dwarfId
  if (isFirstRead) selectedFeed.value = undefined
  try {
    const result = await window.api.getDwarfFeed(dwarfId)
    if (feedToken === token) replaceSelectedFeed(dwarfId, result, 'pull')
  } catch {
    // The bridge is the only source there is. Saying "no transcript this
    // panel can read" is exactly what happened, and it is what the panel
    // already knows how to draw.
    if (feedToken === token) selectedFeed.value = { readable: false, messages: [] }
  }
}

/**
 * Skipped for a held session: it carries its own first-hand exchange on every
 * snapshot, and reading its transcript would fetch the same words second-hand
 * and a turn behind. Bumps feedToken without reading anything, so a read the
 * watch had already started cannot land after the panel moved to a held
 * session (or off a dwarf entirely). Clears `selectedFeedDwarfId` too, so
 * that dwarf's next observed read (if it ever has one) is a first read again
 * rather than treated as a re-read of stale words.
 */
function skipSelectedFeed(): void {
  feedToken++
  selectedFeedDwarfId = null
  selectedFeed.value = undefined
}

/**
 * Read the open dwarf's transcript tail, for a session this panel only
 * OBSERVES. Re-read when either of two signals moves, rather than on every
 * poll, so an idle session still costs no disk at all — and neither signal
 * alone was enough (issue #183). `lastMessage` is the provider reporting the
 * ASSISTANT spoke; it says nothing about a human turn typed into the terminal
 * or sent from this very panel, which sat invisible until the agent next
 * replied. `transcriptUpdatedAt` is the transcript's own raw mtime, and it
 * moves for ANY writer — see Dwarf.transcriptUpdatedAt for why it has to be
 * the raw mtime and not an age derived from it.
 *
 * A third signal, once (#192): the dwarf turning 'leaving'. The final reply
 * and the exit can land inside one poll, so the snapshot that first shows the
 * dwarf leaving is the first that can carry that reply, and neither signal
 * above need have moved for it.
 *
 * Never for a dwarf the board has dropped. Main answers a read only for a
 * dwarf it still has, so a read then would replace the words with "no
 * transcript" — and the kept dwarf's own signals cannot move any more, so the
 * only thing that could still fire this is the leaving signal falling back to
 * false as the live dwarf goes. That is the case the guard is for.
 */
watch(
  [
    openDwarfId,
    () => selectedDwarf.value?.lastMessage,
    () => selectedDwarf.value?.transcriptUpdatedAt,
    () => liveSelectedDwarf.value?.status === 'leaving'
  ],
  ([dwarfId]) => {
    if (dwarfId === null || selectedDwarf.value?.conversation !== undefined) {
      skipSelectedFeed()
      return
    }
    if (liveSelectedDwarf.value === undefined) return
    // A push already carried this exact change (#196): adopting it in
    // update() already set selectedFeed, so pulling again would only re-read
    // words this panel already has.
    if (pushedFeedSignal === watchedFeedSignalKey(dwarfId, selectedDwarf.value)) return
    void readSelectedFeed(dwarfId)
  },
  { immediate: true }
)

/**
 * Tell main which OBSERVED dwarf this panel currently has open, so a poll
 * that already re-scans its transcript can carry the feed with the snapshot
 * instead of this panel pulling it a tick later over its own round trip
 * (#196). Never a held session's: it already carries its own conversation, so
 * main is told null for one exactly as it would be for no selection at all.
 */
watch(
  [openDwarfId, () => selectedDwarf.value?.conversation !== undefined],
  ([dwarfId, isHeld]) => {
    window.api.setWatchedDwarf(dwarfId === null || isHeld ? null : dwarfId)
  },
  { immediate: true }
)

/** A verdict as a plain object, because a Vue proxy cannot cross the bridge. */
function plainVerdicts<T extends DwarfSendState | DwarfKickState>(
  source: Record<string, T>
): Record<string, T> {
  return Object.fromEntries(Object.entries(source).map(([id, verdict]) => [id, { ...verdict }]))
}

/**
 * Publish every delivery verdict to the shell, so the mine can draw its
 * markers on the sprites (#162).
 *
 * Whole reports rather than deltas: both stores expire their own entries on
 * timers, so a verdict missing from a report is a marker whose four seconds are
 * up, and the shell has nothing else that could tell it that.
 */
watch(
  [() => messagingState.byDwarfId, () => kickingState.byDwarfId],
  ([send, kick]) => {
    window.api.reportDwarfDelivery({ send: plainVerdicts(send), kick: plainVerdicts(kick) })
  },
  { deep: true }
)

/**
 * Delivery runs in the background: the panel stays open and usable, and the
 * verdict lands on the dwarf itself (see DwarfSprite's send-result marker,
 * over in the shell) rather than in a modal.
 */
function sendText(dwarf: Dwarf, payload: { text: string; pressEnter: boolean }): void {
  void deliverText(dwarf, payload)
}

/**
 * A delivered send is also a reason to re-read the feed (issue #183): the
 * sending dwarf is always the one this panel has open, so the human's own
 * words are evidence the tail moved, and waiting for `lastMessage` to catch up
 * would mean waiting for the agent to speak next — the bug itself.
 *
 * Re-checked against the CURRENT selection rather than trusting the one
 * captured before the await: the relay can take seconds, and the user is free
 * to close the panel, or select someone else, while it is in flight. A stale
 * delivery for a dwarf nobody has open any more has nothing left to refresh.
 */
async function deliverText(
  dwarf: Dwarf,
  payload: { text: string; pressEnter: boolean }
): Promise<void> {
  const delivered = await sendDwarfText(dwarf.id, payload.text, payload.pressEnter)
  if (!delivered) return
  if (openDwarfId.value !== dwarf.id) return
  if (selectedDwarf.value?.conversation !== undefined) return
  void readSelectedFeed(dwarf.id)
}

/** Same reasoning as sendText: fire-and-observe, verdict lands on the dwarf itself. */
function kickDwarf(dwarf: Dwarf): void {
  void kick(dwarf.id)
}

/**
 * Answer the question that dwarf's agent is blocked on (#125).
 *
 * The question itself is never touched here. It is drawn from the dwarf's own
 * `pendingQuestion` on the latest snapshot, and only main's next snapshot may
 * drop it — the panel's part ends at handing the choice over.
 */
function answerQuestion(dwarf: Dwarf, label: string): void {
  if (dwarf.pendingQuestion === undefined) return
  void answerDwarfQuestion(dwarf.id, dwarf.pendingQuestion, label)
}

/**
 * Release the tool call that dwarf's held session is blocked on (#203).
 *
 * Same shape as answerQuestion, for the same reason: the prompt itself is
 * never touched here. It is drawn from the dwarf's own `pendingPermission` on
 * the latest snapshot, and only main's next snapshot may drop it — the
 * panel's part ends at handing the decision over.
 */
function decidePermission(dwarf: Dwarf, decision: DwarfPermissionDecision): void {
  if (dwarf.pendingPermission === undefined) return
  void decideDwarfPermission(dwarf.id, dwarf.pendingPermission, decision)
}

async function activate(dwarf: Dwarf): Promise<void> {
  error.value = null
  try {
    const result = await window.api.activateDwarf(dwarf.id)
    if (shouldHidePanelAfterActivation(result)) {
      window.api.hidePanel()
      return
    }
    if (result.focused || result.openedTerminal) {
      // A window was focused, or a new terminal now tails the transcript
      // live — nothing else to do, and the panel stays visible.
      return
    }
    // The feed fallback has nowhere to go any more, and needs none: this panel
    // is already showing the session's latest activity, read on its own
    // channel. What is left to say is only that the console itself could not
    // be brought forward (#159).
    error.value = 'The agent terminal could not be opened; its latest activity is above.'
  } catch {
    error.value = 'The agent terminal could not be opened.'
  }
}

/** Close whatever this window has open, which the shell then hears about. */
function close(): void {
  closeLaunchPanel()
  void closePanel()
}

/**
 * Bring THIS window to the front on any press anywhere on it (#162, #165).
 *
 * The same rule the shell holds and for the same reason: a frameless
 * transparent window is not reliably raised by the platform's own
 * click-to-front, so the renderer reports the press and main raises the window
 * that sent it — this one, never the shell, or the surface being typed into
 * would stay exactly where it was.
 */
function raiseWindow(): void {
  window.api.raisePanel()
}

/**
 * The window is as tall as the surface it drew (#162).
 *
 * Measured rather than derived, because the two surfaces answer the height
 * question differently and both answers are already right: the MessagePanel
 * sets its own height from the design's four sizing rules and from a drag, and
 * the Add Panel is content-driven — a chip row, a gate, and a command box that
 * appears. Measuring covers both, and it means a drag on the panel's own
 * handle resizes the WINDOW with nothing extra wired to it.
 *
 * Guarded because ResizeObserver is a browser API a test environment need not
 * have, the same guard MineScene and MapView hold. Reported in design pixels:
 * the page is zoomed by main, so what the renderer measures is the design
 * world, which is the only unit main will accept.
 */
const surfaceRef = ref<HTMLElement | null>(null)
let surfaceObserver: ResizeObserver | undefined

function reportHeight(): void {
  const height = surfaceRef.value?.offsetHeight ?? 0
  // Nothing measured yet is not a height: main refuses it, and a window of no
  // height would be a panel that looks as though it never opened.
  if (height <= 0) return
  window.api.setMessagePanelHeight(height)
}

/**
 * Report again whenever the SURFACE changes, and not only when it resizes.
 *
 * The window is created hidden and main reveals it on the first height report
 * (see setMessagePanelHeight in main/shell/window.ts), so leaving the report to
 * the ResizeObserver alone would leave the window hidden every time the new
 * surface happened to be exactly as tall as the last one — a click that looks
 * as though it did nothing. `nextTick` because the report is a measurement:
 * the panel this state asks for has to be on screen before there is anything
 * to measure.
 */
watch(
  () => panel.value.surface,
  () => {
    void nextTick(reportHeight)
  }
)

let unsubscribe: (() => void) | undefined
let unlistenPanel: (() => void) | undefined

onMounted(() => {
  // Listening BEFORE the pull, deliberately: a state set between the two would
  // otherwise be the one change nobody heard.
  unlistenPanel = listenPanel()
  void syncPanel()
  void load()
  unsubscribe = window.api.onMinesUpdated(update)
  if (typeof ResizeObserver === 'function') {
    surfaceObserver = new ResizeObserver(reportHeight)
    const element = surfaceRef.value
    if (element !== null) surfaceObserver.observe(element)
  }
  reportHeight()
})

onBeforeUnmount(() => {
  unsubscribe?.()
  unlistenPanel?.()
  surfaceObserver?.disconnect()
})
</script>

<template>
  <div class="message-window" @pointerdown.capture="raiseWindow">
    <div ref="surfaceRef" class="message-surface">
      <p v-if="error" class="notice" role="alert">{{ error }}</p>

      <AddPanel
        v-if="launchOpen"
        :chips="launchChips"
        :phase="launchPhase"
        :enabled="launchEnabled"
        :placeholder="launchPlaceholder"
        :command="launchState.command"
        :prompt="launchState.prompt"
        :refusal="launchRefusal"
        :error="launchState.error"
        @choose="chooseProvider"
        @command="setLaunchCommand"
        @commit="commitLaunchCommand"
        @prompt="setLaunchPrompt"
        @submit="submitLaunch"
        @close="close"
      />

      <!--
        Keyed by dwarf, so opening it on another one is a fresh panel: its
        opening height derives from the latest message and is taken once per
        open, which only holds if reopening is a genuine remount.
      -->
      <DwarfMessagePanel
        v-else-if="selectedDwarf"
        :key="selectedDwarf.id"
        :dwarf="selectedDwarf"
        :feed="selectedFeed"
        :send-state="messagingState.byDwarfId[selectedDwarf.id]"
        :kick-state="kickingState.byDwarfId[selectedDwarf.id]"
        :answer-state="questionState.byDwarfId[selectedDwarf.id]"
        @send="sendText(selectedDwarf, $event)"
        @kick="kickDwarf(selectedDwarf)"
        @answer="answerQuestion(selectedDwarf, $event)"
        @decide="decidePermission(selectedDwarf, $event)"
        @open-console="activate(selectedDwarf)"
        @close="close"
      />
    </div>
  </div>
</template>

<style scoped>
/*
 * The whole window, and it paints nothing (#162): the panel inside it draws the
 * design's own #2b2119 surface with its border and its radius, and everything
 * around that has to stay transparent — this is a window on the desktop, not a
 * column inside another one.
 *
 * The surface is held at the BOTTOM, which is the edge main aligns the window
 * on: a panel that grew from a drag grows upward, so the content and the
 * rectangle agree about which edge is fixed.
 */
.message-window {
  display: flex;
  align-items: flex-end;
  height: 100vh;
  overflow: hidden;
  color: var(--color-cream);
  font-size: var(--text-meta);
}
/*
 * What main measures the window against, so it is content-height and must
 * never be stretched: its own height IS the answer to how tall the window is.
 */
.message-surface {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: var(--space-nav-gap);
  min-width: 0;
}
/*
 * The one thing on this surface the design does not draw: why the agent's own
 * console could not be brought forward. Above the panel rather than over it,
 * because the window is measured and anything absolutely positioned here would
 * be a sentence with no room reserved for it.
 */
.notice {
  flex: none;
  margin: 0;
  padding: 9px var(--space-settings);
  border-left: 3px solid var(--danger-line);
  border-radius: var(--radius-default);
  color: var(--danger-ink);
  background: var(--danger-bg);
}
</style>
