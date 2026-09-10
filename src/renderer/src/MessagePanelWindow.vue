<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AddPanel from './components/launch/AddPanel.vue'
import DwarfMessagePanel from './components/message/DwarfMessagePanel.vue'
import { useAgentLaunch } from './composables/useAgentLaunch'
import { useDwarfKicking } from './composables/useDwarfKicking'
import { useDwarfMessaging } from './composables/useDwarfMessaging'
import { useDwarfPaging } from './composables/useDwarfPaging'
import { useDwarfQuestion } from './composables/useDwarfQuestion'
import { useMessagePanel } from './composables/useMessagePanel'
import { useMines } from './composables/useMines'
import { shouldHidePanelAfterActivation } from './lib/delivery/activation'
import { feedMessagesOf } from './lib/message/conversation'
import { joinFeedPages } from './lib/message/feedPages'
import { isWindowDragTarget } from './lib/shell/windowDrag'
import type {
  Dwarf,
  DwarfFeedResult,
  DwarfKickState,
  DwarfPermissionDecision,
  DwarfSendState,
  FeedMessage,
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
const {
  state: messagingState,
  echoes: sentEchoes,
  send: sendDwarfText,
  retry: retryDwarfText,
  observe: observeSends,
  reconcile: reconcileEchoes,
  keepEchoesFor
} = useDwarfMessaging()
/**
 * The pages of conversation older than the newest feed (#364) — held beside
 * `selectedFeed` rather than inside it, for the reasons `useDwarfPaging`
 * states. Everything about WHEN a page is asked for lives there; this window
 * joins what it holds to the newest page for drawing, and says which dwarf the
 * pages belong to.
 */
const {
  state: paging,
  note: pagingNote,
  hold: holdOlderPages,
  older: readOlderPage
} = useDwarfPaging()
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
  modelPicker: launchModelPicker,
  effortPicker: launchEffortPicker,
  permissionsVisible: launchPermissionsVisible,
  open: openLaunchPanel,
  close: closeLaunchPanel,
  choose: chooseProvider,
  setCommand: setLaunchCommand,
  commit: commitLaunchCommand,
  setPrompt: setLaunchPrompt,
  setModel: setLaunchModel,
  setEffort: setLaunchEffort,
  setPermissionMode: setLaunchPermissionMode,
  submit: submitLaunch,
  observe: observeLaunch,
  listenFailures: listenLaunchFailures
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
 *
 * The NEWEST page of it, and since #364 that is a distinction worth the word:
 * this holds the latest FEED_LIMIT things said and is replaced whole by every
 * re-read and every watched push, while the pages a reader scrolled back to are
 * held separately (`useDwarfPaging`) and joined to it in `pagedMessages`.
 */
const selectedFeed = ref<DwarfFeedResult | undefined>(undefined)
/** Which read is the current one, so a slow answer cannot land on a later dwarf. */
let feedToken = 0

/**
 * What the panel DRAWS: every older page the reader has fetched, oldest first,
 * with the newest page at its foot (#364).
 *
 * Joined here and nowhere else. `selectedFeed` above stays the newest page and
 * only the newest page — replaced whole by every re-read and by every watched
 * push — so the pages a reader scrolled back to survive a session that keeps
 * talking, and the shrink guard below keeps comparing one newest page against
 * another rather than against a conversation that legitimately grew upward.
 */
const pagedMessages = computed<FeedMessage[]>(() =>
  joinFeedPages(paging.pages, selectedFeed.value?.messages ?? [])
)

/**
 * The same answer `selectedFeed` carries, with the drawn conversation in place
 * of its own page. `undefined` still means the read has not come back, which
 * the panel says out loud rather than drawing as an empty conversation — and
 * with no read back there are no pages either, because a switch cleared them.
 */
const drawnFeed = computed<DwarfFeedResult | undefined>(() =>
  selectedFeed.value === undefined
    ? undefined
    : { readable: selectedFeed.value.readable, messages: pagedMessages.value }
)
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
 *
 * ## The one thing this must not compare, since #364
 *
 * The subject of the comparison is the NEWEST PAGE — `selectedFeed` before and
 * after, nothing else. It is emphatically NOT `pagedMessages`, the conversation
 * the panel draws: once a reader has paged back, that list holds twelve rows
 * per page fetched, and every ordinary push carrying the newest twelve would
 * read as a catastrophic shrink. The warning would fire twice a second on a
 * busy session and mean nothing, which is worse than not having it.
 *
 * Which is also why the pages are not touched here. This replaces one page of a
 * conversation; the pages in front of it belong to the reader's own scroll and
 * are thrown away only by a genuine switch (see `holdOlderPages`). Everything
 * that reads the newest feed for its own purposes keeps reading exactly that:
 * echo reconciliation (#309) measures the person's pending words against the
 * live end of the transcript, and the reaction watch (#21) against the same,
 * because a message sent a moment ago is answered at the end of a conversation
 * and never four pages back.
 */
function replaceSelectedFeed(dwarfId: string, next: DwarfFeedResult, via: 'push' | 'pull'): void {
  if (import.meta.env.DEV) {
    const previousPage = selectedFeed.value
    const lost =
      previousPage !== undefined &&
      selectedFeedDwarfId === dwarfId &&
      (next.messages.length < previousPage.messages.length ||
        (previousPage.readable && !next.readable))
    if (lost) {
      console.warn(
        `[panel] newest feed page for ${dwarfId} shrank via ${via}: ${previousPage.messages.length} -> ${next.messages.length}, readable=${next.readable}`
      )
    }
  }
  selectedFeedDwarfId = dwarfId
  holdOlderPages(dwarfId)
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
  // Before the await, not after it: on a first read the pages of whoever the
  // panel was on last must go with their feed, or they would be drawn under
  // the new dwarf's name for as long as this read takes (#364).
  holdOlderPages(dwarfId)
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
 *
 * And the older pages with it (#364): a held session's words come from its own
 * stream rather than from a transcript this panel pages, so there is nothing
 * left for the pages to stand in front of.
 */
function skipSelectedFeed(): void {
  feedToken++
  selectedFeedDwarfId = null
  holdOlderPages(null)
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

/**
 * Fetch the page of conversation before the oldest row on screen (#364) — the
 * reader having scrolled back to the top of what this panel holds.
 *
 * Never for a held session: it carries its own exchange first-hand, and there
 * is no transcript read behind it to page (the same reason `skipSelectedFeed`
 * exists). Everything else the request has to refuse — one read at a time, no
 * read once the start is reached, nothing to page before — belongs to
 * `useDwarfPaging`, so a repeated report from the panel costs nothing.
 *
 * The cursor comes off `pagedMessages` — the transcript rows themselves —
 * rather than off the conversation `conversationOf` draws. Those two differ in
 * exactly one case that matters here: with no feed read back the panel falls
 * back to the `lastMessage` every poll carries, a bubble whose timestamp is the
 * honest empty string because the poll says what was said and never when. It is
 * not a row of any transcript, so it can never name a place in one.
 */
function pageBack(): void {
  const dwarfId = openDwarfId.value
  if (dwarfId === null) return
  if (selectedDwarf.value?.conversation !== undefined) return
  void readOlderPage(dwarfId, pagedMessages.value)
}

/**
 * The messages this panel is still holding on the person's behalf, and the
 * transcript they are measured against (#309).
 *
 * `feedMessagesOf` rather than a second reading of "held wins over observed":
 * it is the very precedence `conversationOf` draws the panel from, so the rows
 * an echo is reconciled against are exactly the rows it would otherwise be
 * drawn beside.
 *
 * The NEWEST page, deliberately, and not the paged-back conversation (#364):
 * an echo is words the person sent a moment ago, so the transcript that
 * accounts for them is the live end of it. Measuring against pages of older
 * conversation could only ever find the same words said earlier and drop a
 * bubble whose own delivery nobody had watched — which is the failure #309
 * exists to end, one turn removed.
 */
const echoTranscript = computed<readonly FeedMessage[]>(() =>
  selectedDwarf.value === undefined ? [] : feedMessagesOf(selectedDwarf.value, selectedFeed.value)
)

/**
 * Drop an echo the moment the transcript accounts for it, so the person's
 * words appear once rather than twice (#309).
 *
 * Here rather than in the panel because the panel is thin and this is a store
 * write; on the default ('pre') flush, so the drop lands before the render
 * that would otherwise have drawn the row and the echo side by side. For a
 * held session the stream carries the user turn almost at once, which is why
 * this watches the conversation and not only a completed feed read.
 */
watch(
  [openDwarfId, echoTranscript],
  ([dwarfId, messages]) => {
    if (dwarfId === null) return
    reconcileEchoes(dwarfId, messages)
  },
  { immediate: true }
)

/**
 * An echo belongs to the conversation on screen, and to no other (#309).
 *
 * A panel that moved to another dwarf is no longer holding anything for the
 * one it left: those bubbles are gone from the surface, and keeping their
 * verdicts alive would mean a message failing invisibly for a dwarf nobody is
 * looking at.
 */
watch(openDwarfId, (dwarfId) => keepEchoesFor(dwarfId), { immediate: true })

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

/** Hand the composer's text over, then refresh on the verdict (#183). */
async function deliverText(
  dwarf: Dwarf,
  payload: { text: string; pressEnter: boolean }
): Promise<void> {
  refreshAfterDelivery(dwarf.id, await sendDwarfText(dwarf.id, payload.text, payload.pressEnter))
}

/**
 * Send a failed message again, from its own bubble (#309).
 *
 * Fire-and-observe and post-delivery re-read exactly as an ordinary send: it
 * IS an ordinary send, of words the store already holds. The store mints a new
 * echo for it and leaves the failed one marked — a retry is a second delivery
 * with its own verdict, not a correction of the first.
 */
function sendAgain(dwarf: Dwarf, echoId: string): void {
  void retryDwarfText(dwarf.id, echoId).then((delivered) =>
    refreshAfterDelivery(dwarf.id, delivered)
  )
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
 *
 * Shared by both ways of handing text over since #309 — the composer's send
 * and a retry from a failed bubble — because a retry is the same delivery with
 * the same aftermath.
 */
function refreshAfterDelivery(dwarfId: string, delivered: boolean): void {
  if (!delivered) return
  if (openDwarfId.value !== dwarfId) return
  if (selectedDwarf.value?.conversation !== undefined) return
  void readSelectedFeed(dwarfId)
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

/**
 * Open an activity line's own path in the OS default app (#279).
 *
 * Resolved and verified entirely in main, against the mine's own folder —
 * this window only relays the click and shows whatever main decided, on the
 * same status line `activate` already uses for "the console could not be
 * opened" (see the `.notice` element below).
 */
async function openPath(target: string): Promise<void> {
  if (currentMine.value === undefined) return
  error.value = null
  try {
    // The dwarf travels with the click (#348). A mine folded from several
    // worktrees has a crew in several folders, and a relative path on this
    // dwarf's activity line is relative to ITS session's cwd — main reads that
    // off the board; this window still names no folder.
    const result = await window.api.openMinePath({
      mineId: currentMine.value.id,
      target,
      ...(selectedDwarf.value === undefined ? {} : { dwarfId: selectedDwarf.value.id })
    })
    if (!result.opened) error.value = result.reason
  } catch {
    error.value = 'That file could not be opened.'
  }
}

/**
 * Open a link from a message bubble in the system browser (#347).
 *
 * The same division `openPath` above draws, and for a stronger reason: the
 * address came out of an untrusted transcript. Main validates it — `http:` or
 * `https:`, nothing else — and main owns the only `shell.openExternal` in the
 * app, so this window relays the press and shows whatever main decided on the
 * same `.notice` line the two cases above use.
 *
 * No mine is needed and none is checked, unlike `openPath`: a web address is
 * not resolved against anything, so there is no folder for it to belong to.
 */
async function openLink(href: string): Promise<void> {
  error.value = null
  try {
    const result = await window.api.openExternalLink(href)
    if (!result.opened) error.value = result.reason
  } catch {
    error.value = 'That link could not be opened.'
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
 * Move this window by its header, and snap it back (#296).
 *
 * ## Why the gesture is wired here and not in the panel
 *
 * At the WINDOW level, because that is what is being moved: the two surfaces
 * that share this window each draw the same header row and neither of them
 * knows it is in a window at all. They mark the row (`data-window-drag`, see
 * `lib/shell/windowDrag`) and this listens for presses that landed on it —
 * one place that decides, and a press on a control inside the row is still
 * that control's.
 *
 * ## Why a pointer report and not `-webkit-app-region: drag`
 *
 * The CSS region is less code and it was refused. It hands the move to the OS,
 * so MAIN never learns the window was dragged until after the fact — and main
 * is the owner of every rectangle in this app (`usePanelLayout`: state only
 * ever becomes something main REPORTED). It cannot clamp a drag to the display
 * while it is happening, only correct it afterwards. It also inverts the
 * default: every interactive child of the region has to be marked `no-drag`
 * one by one, so a control added to the header later becomes a drag handle
 * silently, and the person loses a button rather than gaining one. What is
 * paid for that is the two messages below, and main polling the cursor while
 * the press is down (see MessagePanelDragPhase).
 */
/**
 * Whether the press currently down began a drag — so a release anywhere else
 * on this window is not reported as the end of one. Main persists the position
 * on every 'end' it is told about, and a click on the conversation is not a
 * gesture that produced a position.
 */
let windowDragging = false

function startWindowDrag(event: PointerEvent): void {
  if (!isWindowDragTarget(event.target)) return
  // Captured on this element so the release still reaches us once the window
  // has moved out from under the cursor, and so a pointer that leaves the
  // window entirely cannot leave a drag running with nothing to end it.
  const root = event.currentTarget
  if (root instanceof Element) root.setPointerCapture(event.pointerId)
  windowDragging = true
  window.api.dragMessagePanel('start')
}

function endWindowDrag(): void {
  if (!windowDragging) return
  windowDragging = false
  window.api.dragMessagePanel('end')
}

/** Double-click the header: back beside the shell, and the position forgotten. */
function dockWindow(event: MouseEvent): void {
  if (!isWindowDragTarget(event.target)) return
  window.api.dockMessagePanel()
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
 * What the surface is DRAWING, as one comparable value: which panel, and for
 * which dwarf.
 *
 * A string rather than the three parts, for the reason the `state.mines` watch
 * above gives its own shape: `selectedDwarf` is recomputed from every poll, so
 * a getter answering a fresh array would fire the watch below twice a second
 * and re-place the window each time. Identity is the whole of what matters
 * here, and it fits in a string.
 */
const surfaceContentKey = computed(
  () => `${panel.value.surface}|${launchOpen.value}|${selectedDwarf.value?.id ?? ''}`
)

/**
 * Report again whenever the surface's CONTENT changes, and not only when it
 * resizes.
 *
 * The window is created hidden and main reveals it on the first height report
 * (see setMessagePanelHeight in main/shell/window.ts), so leaving the report to
 * the ResizeObserver alone would leave the window hidden every time the new
 * surface happened to be exactly as tall as the last one — a click that looks
 * as though it did nothing. `nextTick` because the report is a measurement:
 * the panel this state asks for has to be on screen before there is anything
 * to measure.
 *
 * ## Why the surface alone was not enough (#312)
 *
 * The surface is what main was ASKED for; the content is what arrived. On the
 * first open of a run those are two different moments and in that order: this
 * window learns the surface from `syncPanel`, and the board that decides WHICH
 * dwarf to draw lands on the `getMines` after it. So the report the surface
 * change fired measured an empty surface, was suppressed by the rule below as
 * a zero, and nothing reported again when the dwarf's panel finally mounted —
 * leaving main holding a created, hidden window with no height and no second
 * way to reveal it. Selecting another dwarf had the same gap: the surface stays
 * 'message' throughout, so only the observer saw the new panel.
 *
 * And the observer cannot cover either, because the window it would cover them
 * for is HIDDEN. A ResizeObserver callback is delivered while the page's
 * rendering is updated, and Electron's own contract for a backgrounded page is
 * that "animations and timers are paused" unless `backgroundThrottling` is
 * disabled, in which case "frames will continue to be drawn and swapped for
 * the entire window". That flag is deliberately NOT set here: it would keep a
 * window that spends most of the app's life hidden drawing frames, and it
 * "also impacts the Page Visibility API" for both surfaces — a real cost for a
 * report this window can simply make at the moment it knows about, which is
 * the change of content itself. Once the window is visible the observer works,
 * which is why one report is all that has to be guaranteed.
 *
 * One `nextTick` is enough to measure the final panel: DwarfMessagePanel takes
 * its opening height during setup and binds it on its own root, so the first
 * render already carries it.
 */
watch(surfaceContentKey, () => {
  void nextTick(reportHeight)
})

let unsubscribe: (() => void) | undefined
let unlistenPanel: (() => void) | undefined
/** Main's launch-failure push (#263), subscribed alongside every other main-side listener. */
let unlistenLaunchFailures: (() => void) | undefined

onMounted(() => {
  // Listening BEFORE the pull, deliberately: a state set between the two would
  // otherwise be the one change nobody heard.
  unlistenPanel = listenPanel()
  void syncPanel()
  void load()
  unsubscribe = window.api.onMinesUpdated(update)
  unlistenLaunchFailures = listenLaunchFailures()
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
  unlistenLaunchFailures?.()
  surfaceObserver?.disconnect()
})
</script>

<template>
  <div
    class="message-window"
    @pointerdown.capture="raiseWindow"
    @pointerdown="startWindowDrag"
    @pointerup="endWindowDrag"
    @pointercancel="endWindowDrag"
    @dblclick="dockWindow"
  >
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
        :model-picker="launchModelPicker"
        :effort-picker="launchEffortPicker"
        :permissions-visible="launchPermissionsVisible"
        @choose="chooseProvider"
        @command="setLaunchCommand"
        @commit="commitLaunchCommand"
        @prompt="setLaunchPrompt"
        @model="setLaunchModel"
        @effort="setLaunchEffort"
        @permission-mode="setLaunchPermissionMode"
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
        :feed="drawnFeed"
        :paging-note="pagingNote ?? undefined"
        :send-state="messagingState.byDwarfId[selectedDwarf.id]"
        :echoes="sentEchoes[selectedDwarf.id]"
        :kick-state="kickingState.byDwarfId[selectedDwarf.id]"
        :answer-state="questionState.byDwarfId[selectedDwarf.id]"
        @send="sendText(selectedDwarf, $event)"
        @send-again="sendAgain(selectedDwarf, $event)"
        @kick="kickDwarf(selectedDwarf)"
        @answer="answerQuestion(selectedDwarf, $event)"
        @decide="decidePermission(selectedDwarf, $event)"
        @open-console="activate(selectedDwarf)"
        @open-path="openPath"
        @open-link="openLink"
        @page-back="pageBack"
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
 * The one tell that the header row moves the whole window (#296).
 *
 * Unspecified in the design source, and the amendment the maintainer approved
 * names it rather than leaving the handle invisible: a frameless window has no
 * title bar, so with no cursor change there is nothing at all to say the row
 * can be grabbed. `grab` is the platform's own vocabulary for exactly that and
 * costs no ink.
 *
 * Written here rather than in either panel because the drag belongs to the
 * WINDOW: both surfaces mark their header (see lib/shell/windowDrag) and know
 * nothing about being in one. The second rule restores what the controls
 * inside the row already declare for themselves — the name opens a console and
 * the glyph closes the panel, and a grab cursor over either would promise a
 * gesture that lands on the control instead.
 */
.message-window :deep([data-window-drag]) {
  cursor: grab;
}
.message-window :deep([data-window-drag] button) {
  cursor: pointer;
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
