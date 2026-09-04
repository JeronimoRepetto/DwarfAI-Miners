<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AddPanel from './components/launch/AddPanel.vue'
import DwarfMessagePanel from './components/message/DwarfMessagePanel.vue'
import MineHistoryPanel from './components/history/MineHistoryPanel.vue'
import EdgeRail from './components/shell/EdgeRail.vue'
import MapView from './components/map/MapView.vue'
import MineScene from './components/scene/MineScene.vue'
import MinesPanel from './components/browse/MinesPanel.vue'
import PanelFrame from './components/shell/PanelFrame.vue'
import SettingsPanel from './components/panel/SettingsPanel.vue'
import ShellNav from './components/shell/ShellNav.vue'
import UnavailablePanel from './components/shell/UnavailablePanel.vue'
import { useAgentLaunch } from './composables/useAgentLaunch'
import { useDwarfKicking } from './composables/useDwarfKicking'
import { useDwarfMessaging } from './composables/useDwarfMessaging'
import { useDwarfQuestion } from './composables/useDwarfQuestion'
import { useMines } from './composables/useMines'
import { usePanelLayout } from './composables/usePanelLayout'
import { usePinnedWindow } from './composables/usePinnedWindow'
import { useProjectBrowse } from './composables/useProjectBrowse'
import { useResetMetrics } from './composables/useResetMetrics'
import { useToggleShortcut } from './composables/useToggleShortcut'
import { useView } from './composables/useView'
import { INTERIOR_ART_SIZE } from './lib/art'
import { shellComposition } from './lib/shell/composition'
import { versionLabel, versionTitle } from './lib/appBuild'
import { shouldHidePanelAfterActivation } from './lib/delivery/activation'
import type {
  AppBuild,
  Dwarf,
  DwarfFeedResult,
  Mine,
  MineHistoryResult,
  MinesSnapshot,
  ShellArea
} from './types'

const { state, setMines } = useMines()
const { state: viewState, openMine, closeMine, showArea, showMap, syncWithMines } = useView()
const { state: messagingState, send: sendDwarfText } = useDwarfMessaging()
const { state: kickingState, kick } = useDwarfKicking()
const { state: questionState, answer: answerDwarfQuestion } = useDwarfQuestion()

/**
 * Launching an agent from inside a mine (#86). App owns this composable — and
 * therefore the bridge — for the reason it owns every other one, and it owns
 * the DOCK: the Add Panel and the MessagePanel share one slot at the bottom of
 * the shell, which is the design's own transition (submitting replaces one with
 * the other), so which of them is drawn cannot be decided by either.
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
const { pinned, sync: syncPinned, toggle: togglePinned } = usePinnedWindow()

/**
 * The docked shell's own shape (#90). `layout` is only ever what MAIN reported,
 * because the window's rectangle is derived from the display: the rail's arrow
 * is drawn from `layout.edge`, and drawing it from a guess would point the user
 * off the screen.
 */
const {
  layout,
  applying: layoutApplying,
  sync: syncLayout,
  apply: applyLayout,
  toggle: toggleLayout,
  setEdge
} = usePanelLayout()

/**
 * Which of the book's three compositions is on screen (#156).
 *
 * Named once, here, and handed to everything that has to know — the shell's own
 * ground and padding, and the rail. Read from `expanded` alone, the mine-only
 * composition was indistinguishable from the collapsed rail, which is what left
 * a void between the navigation column and the mine, took the amber frame with
 * it, grew the interior into padding that was no longer reserved, and put a
 * second app mark in the gap. See lib/shell/composition.ts.
 */
const composition = computed(() => shellComposition(layout.value))

// The hover line explains what the CURRENT state does; the accessible name
// stays stable and aria-pressed carries the state (see the pin button below).
const pinTooltip = computed(() =>
  pinned.value
    ? 'Pinned: the panel stays above other windows'
    : 'Unpinned: other windows can cover the panel'
)

/**
 * Settings surface (see #17). App owns the composable — and therefore the IPC —
 * so ShortcutSettings can stay presentational and the "render only what main
 * verified" rule lives in exactly one place.
 */
const {
  state: shortcutState,
  error: shortcutError,
  recording: shortcutRecording,
  applying: shortcutApplying,
  sync: syncShortcut,
  startRecording: startShortcutRecording,
  stopRecording: stopShortcutRecording,
  record: recordShortcut,
  reset: resetShortcut
} = useToggleShortcut()

/**
 * Settings' "Reset metrics" action (#138). Same reasoning as the shortcut
 * surface above: App owns the composable and therefore the IPC, so
 * SettingsPanel's reset modal stays presentational and the "render only what
 * main verified" rule stays in exactly one place.
 */
const {
  resetting: metricsResetting,
  error: metricsResetError,
  reset: resetMetrics
} = useResetMetrics()

/**
 * The browse over every project the app remembers (#92). App owns the
 * composable — and therefore the IPC — for the same reason it owns the shortcut
 * one: MinesPanel then stays presentational, and the honesty rules about what a
 * refused query may render live in exactly one place.
 */
const {
  filters: browseFilters,
  projects,
  loading: browseLoading,
  error: browseError,
  exhausted: browseExhausted,
  adding: addingProject,
  addError: addProjectError,
  load: loadProjects,
  loadMore: loadMoreProjects,
  setSearch: setProjectSearch,
  setTier: setProjectTier,
  toggleDirection: toggleProjectOrder,
  addProject
} = useProjectBrowse()

/**
 * A shortcut the OS refused is flagged on the navigation stack's Settings
 * button, without anything being opened: a failure the user only meets after
 * opening settings is a failure they never look for. It was flagged on the old
 * titlebar's gear, which the design replaced.
 */
const shortcutBroken = computed(
  () => shortcutState.value !== null && !shortcutState.value.registered
)

/**
 * Selecting an area never closes the mine held open beside it — that is the
 * design's concurrent model, and it is the whole reason the two are separate
 * pieces of state.
 *
 * Every open reads the browse's first page again: the list spans projects
 * nobody is working, so nothing pushes it and a remembered page would age
 * silently. Leaving the recorder listening across a switch would capture
 * keystrokes the next time settings came back.
 */
function selectArea(area: ShellArea): void {
  if (viewState.area === 'settings' && area !== 'settings') stopShortcutRecording()
  showArea(area)
  error.value = null
  if (area === 'mines') void loadProjects()
}

/** The browse and the board share one id scheme, so a card opens its mine directly. */
function openFromBrowse(projectId: string): void {
  openMine(projectId)
  error.value = null
}

/**
 * Which build is running (see #79). Read from main once on mount, because a
 * version cannot change under a live process — there is nothing to keep in
 * step and nothing to subscribe to.
 *
 * Null until it arrives, and null forever if the read fails, in which case the
 * settings panel prints nothing at all. That is deliberate: a placeholder like
 * "unknown" would be furniture for a case that means the bridge itself is
 * down, and inventing a version where the real one belongs is the one failure
 * this whole feature exists to prevent.
 */
const build = ref<AppBuild | null>(null)
const versionText = computed(() => (build.value === null ? null : versionLabel(build.value)))
const versionHint = computed(() => (build.value === null ? '' : versionTitle(build.value)))

/**
 * The interior painting's own shape, published to CSS so the mine column can
 * derive its width from the height the shell gives it (#153). Bound from
 * `INTERIOR_ART_SIZE` rather than written into the stylesheet, so the column and
 * the projection inside it cannot disagree about the painting.
 */
const interiorColumnAspect = `${INTERIOR_ART_SIZE.width} / ${INTERIOR_ART_SIZE.height}`

const loading = ref(true)
const error = ref<string | null>(null)
const activating = ref<string | null>(null)
let unsubscribe: (() => void) | undefined

/**
 * The dwarf the message panel is open on (#159).
 *
 * At most one in the whole app, which is why it lives here rather than in a
 * sprite: the design docks the panel at the bottom of the screen, not beside
 * the dwarf, so no sprite can hold the fact that it is the selected one.
 */
const selectedDwarfId = ref<string | null>(null)

/**
 * The dwarf the message panel is actually open on: the one that was clicked, or
 * the one a launch turned out to have started (#86).
 *
 * DERIVED rather than assigned, and that is the whole point. The design's
 * transition is the Add Panel being replaced by the MessagePanel on the new
 * dwarf, which reads like a moment to react to — but a handover carried out by
 * a watcher is a handover that can be missed, and the launch state is a shared
 * singleton that more than one mounted App can be watching. Reading it is a
 * statement that stays true however many times it is read.
 */
const openDwarfId = computed(() => launchState.value.launchedDwarfId ?? selectedDwarfId.value)

/**
 * The transcript read for the selected dwarf, for a session this panel only
 * OBSERVES. `undefined` means the read has not come back — which the panel
 * says out loud rather than drawing as an empty conversation.
 */
const selectedFeed = ref<DwarfFeedResult | undefined>(undefined)
/** Which read is the current one, so a slow answer cannot land on a later dwarf. */
let feedToken = 0

const currentMine = computed<Mine | undefined>(() =>
  viewState.mineId === null ? undefined : state.mines.find((mine) => mine.id === viewState.mineId)
)

/**
 * The mine column is width the WINDOW has to be given before anything can be
 * drawn into it, so opening or closing a mine reshapes the shell. Serialized in
 * usePanelLayout behind whatever the rail is doing, because the two overlap.
 *
 * The secondary panel is left exactly as it is (#153): the two columns are
 * independent now, so a mine opening beside a closed secondary must not reopen
 * it, and a mine closing while the secondary is closed leaves the rail.
 */
watch(
  () => viewState.mineId !== null,
  (mineOpen) => {
    // Collapsed into the rail: nothing is drawn, and a mine opened behind it
    // must not pop the window back out.
    if (!layout.value.expanded && !layout.value.mineOpen) return
    void applyLayout({ expanded: layout.value.expanded, mineOpen })
  }
)

/**
 * The rail's arrow (#153): it closes the SECONDARY panel and leaves a mine held
 * open beside it standing — the design's own mine mock is exactly that state.
 * With no mine open there is nothing left to show, so it lands on the rail.
 */
function toggleSecondary(): void {
  void toggleLayout(viewState.mineId !== null)
}

function hidePanel(): void {
  window.api.hidePanel()
}

/**
 * Bring the window to the front on any press anywhere on the shell (#165).
 *
 * The third acceptance run found the panel sitting BEHIND whatever program had
 * the foreground — alive, taking the click, and never raised. The shell is a
 * frameless transparent window, which the platform's own click-to-front does
 * not reliably apply to, so the renderer reports the press and main raises the
 * window itself (see raisePanelWindow in main/shell/window.ts).
 *
 * On the CAPTURE phase, and on `pointerdown` rather than `click`: every control
 * on the panel stops its own click, and the window has to rise before any of
 * them decides anything. Nothing here reads the pin — pinning decides whether
 * the panel STAYS above other windows, not whether a click may bring it there.
 */
function raisePanel(): void {
  window.api.raisePanel()
}

function update(snapshot: MinesSnapshot): void {
  setMines(snapshot)
  loading.value = false
  syncWithMines(snapshot.mines.map((mine) => mine.id))
  // A launch in flight is watching for its own dwarf, which arrives on an
  // ordinary poll like every other session's — this is that poll.
  observeLaunch(snapshot.mines)
  if (import.meta.env.DEV) {
    console.log(
      '[renderer] mines:',
      snapshot.mines
        .map((mine) => `${mine.name} (${mine.tier}, ${mine.dwarfs.length} dwarfs)`)
        .join('; ') || 'none'
    )
  }
}

async function load(): Promise<void> {
  try {
    update(await window.api.getMines())
  } catch {
    error.value =
      'DwarfAI-Miners could not load active mines. It will keep trying as activity changes.'
    loading.value = false
  }
}

async function loadBuild(): Promise<void> {
  try {
    build.value = await window.api.getAppBuild()
  } catch {
    // Main is the only source there is, so there is nothing to fall back on
    // and nothing worth guessing: the settings panel stays as it was.
  }
}

function enterMine(mineId: string): void {
  openMine(mineId)
  error.value = null
}

function leaveMine(): void {
  closeMine()
  error.value = null
}

/** The selected dwarf as the CURRENT snapshot reports it, or nothing once the board dropped it. */
const liveSelectedDwarf = computed<Dwarf | undefined>(() =>
  openDwarfId.value === null
    ? undefined
    : currentMine.value?.dwarfs.find((dwarf) => dwarf.id === openDwarfId.value)
)

/**
 * The selected dwarf as the board LAST reported it (#192).
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

/** Clicking the selected dwarf again closes its panel, as a toggle should. */
function selectDwarf(dwarf: Dwarf): void {
  // The three panels share one dock, so opening this one puts the others away.
  // Deliberately not the launch's own `close()` half-way through a spawn: a
  // selection during one abandons the handover, which is the user saying they
  // would rather look at something else, and the session is unaffected.
  closeLaunchPanel()
  historyOpen.value = false
  selectedDwarfId.value = selectedDwarfId.value === dwarf.id ? null : dwarf.id
}

/**
 * Whether the Mine History panel is open on the current mine (#192).
 *
 * A boolean rather than a mine id, because it is a statement about the mine
 * held open beside it and nothing else: the panel is keyed by that mine, so
 * changing mines is a fresh panel, and the watch below closes it outright when
 * the mine goes — the same rule the message panel follows.
 */
const historyOpen = ref(false)

/**
 * What main read for the open mine's history. `undefined` means no answer has
 * come back yet, which the panel says out loud rather than drawing as an empty
 * mine. Deliberately NOT reset when a re-read starts: the previous answer stays
 * on screen until the next lands, or a live update would flash "reading" over
 * a transcript somebody is in the middle of.
 */
const mineHistory = ref<MineHistoryResult | undefined>(undefined)
/** Which read is the current one, so a slow answer cannot land on a later mine. */
let historyToken = 0

/** The mine's History action (#192): the dock is one, so the other two panels go. */
function openHistory(): void {
  closeLaunchPanel()
  selectedDwarfId.value = null
  historyOpen.value = true
}

function closeHistory(): void {
  historyOpen.value = false
}

async function readMineHistory(mineId: string): Promise<void> {
  const token = ++historyToken
  try {
    const result = await window.api.getMineHistory(mineId)
    if (historyToken === token) mineHistory.value = result
  } catch {
    // The bridge is the only source there is. "Could not be read" is exactly
    // what happened, and it is a different statement from "nobody has spoken".
    if (historyToken === token) mineHistory.value = { readable: false, speakers: [] }
  }
}

/**
 * The signal the history re-reads on while open: the SAME two the message
 * panel's feed watches (#183, see the watch below it), over every dwarf in the
 * mine rather than the one selected — `lastMessage` for an agent that spoke,
 * `transcriptUpdatedAt` for any writer at all — plus a dwarf turning 'leaving'
 * or dropping off the board, since its final words land with its exit (#192).
 * Folded into one string so the watch fires on a change to any of them and
 * stays silent on a poll that moved none: an idle mine costs no disk.
 */
const crewSignal = computed(() =>
  (currentMine.value?.dwarfs ?? [])
    .map(
      (dwarf) =>
        `${dwarf.id}|${dwarf.lastMessage ?? ''}|${dwarf.transcriptUpdatedAt ?? ''}|${dwarf.status === 'leaving'}`
    )
    .join('\n')
)

watch(
  [historyOpen, () => viewState.mineId, crewSignal],
  ([open, mineId]) => {
    if (!open || mineId === null) {
      // Nothing to show: bump the token so a read still in flight cannot land
      // on a panel that has since closed or moved to another mine.
      historyToken++
      mineHistory.value = undefined
      return
    }
    void readMineHistory(mineId)
  },
  { immediate: true }
)

/**
 * The mine's Add action (#86).
 *
 * Re-opening the panel already open on this mine is left alone rather than
 * treated as a toggle: `open()` starts a fresh panel, so a second click would
 * silently discard a prompt somebody was half-way through typing. The panel has
 * its own close, and Escape.
 */
function openLaunch(mineId: string): void {
  if (launchMineId.value === mineId && launchPhase.value !== 'closed') return
  selectedDwarfId.value = null
  historyOpen.value = false
  void openLaunchPanel(mineId)
}

/**
 * Close the message panel — including one a launch handed over.
 *
 * The launch is closed too, because until it is, `openDwarfId` still reads its
 * adopted dwarf and the panel would reopen on the next render. Closing it is
 * also the honest act: the handover is what the launch was still holding, and
 * the session itself is untouched either way.
 */
function closeMessages(): void {
  selectedDwarfId.value = null
  closeLaunchPanel()
}

/**
 * (Re-)read the selected dwarf's transcript tail, for a session this panel
 * only observes.
 *
 * Bumps feedToken first, so an answer already in flight — from the watch
 * below, or from an earlier call here — cannot land after a fresher one has
 * started; only the newest token's answer is ever kept (issue #183: the
 * panel's own send is now a second caller of this, beside the watch).
 */
async function readSelectedFeed(dwarfId: string): Promise<void> {
  const token = ++feedToken
  selectedFeed.value = undefined
  try {
    const result = await window.api.getDwarfFeed(dwarfId)
    if (feedToken === token) selectedFeed.value = result
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
 * session (or off a dwarf entirely).
 */
function skipSelectedFeed(): void {
  feedToken++
  selectedFeed.value = undefined
}

/**
 * Read the selected dwarf's transcript tail, for a session this panel only
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
    void readSelectedFeed(dwarfId)
  },
  { immediate: true }
)

/*
 * The panel follows its MINE, not the board (#192). Its dwarf walking out no
 * longer closes it — that is the moment the conversation is worth reading —
 * but the mine going away does: closing the mine is the person's own act, and
 * a mine the board dropped takes the scene the panel was docked beside with it.
 */
watch(
  () => viewState.mineId,
  () => {
    // The history panel follows its mine the same way (#192): a person closing
    // the mine, or the board dropping it, takes the history with it.
    historyOpen.value = false
    if (openDwarfId.value === null) return
    selectedDwarfId.value = null
    // A launch whose adopted dwarf has lost its mine is over too, or its id
    // would keep reopening a panel onto a session with nowhere to be shown.
    if (launchState.value.launchedDwarfId !== null) closeLaunchPanel()
  }
)

async function activate(dwarf: Dwarf): Promise<void> {
  activating.value = dwarf.id
  error.value = null
  try {
    const result = await window.api.activateDwarf(dwarf.id)
    if (shouldHidePanelAfterActivation(result)) {
      hidePanel()
      return
    }
    if (result.focused || result.openedTerminal) {
      // A window was focused, or a new terminal now tails the transcript
      // live — nothing else to do, and the panel stays visible (it is
      // alwaysOnTop, so it never needs to get out of the way).
      return
    }
    // The feed fallback has nowhere to go any more, and needs none: the
    // message panel is already showing this session's latest activity, read on
    // its own channel. What is left to say is only that the console itself
    // could not be brought forward (#159).
    error.value = 'The agent terminal could not be opened; its latest activity is below.'
  } catch {
    error.value = 'The agent terminal could not be opened.'
  } finally {
    activating.value = null
  }
}

/**
 * Delivery runs in the background: the panel stays open and usable, and the
 * verdict lands on the dwarf itself (see DwarfSprite's send-result marker)
 * rather than in a modal.
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

onMounted(() => {
  void load()
  // Adopts the window's REAL shape: which edge it is docked to decides which
  // way the rail's arrow points, and the renderer never chose it.
  void syncLayout()
  // The button's initial "pinned" guess matches main's default; this adopts
  // the real BrowserWindow state (the user may have unpinned on a past run).
  void syncPinned()
  // Reads the accelerator AND whether it actually registered, so a startup
  // failure can be flagged on the Settings button before anyone opens it.
  void syncShortcut()
  void loadBuild()
  unsubscribe = window.api.onMinesUpdated(update)
})
onBeforeUnmount(() => unsubscribe?.())
</script>

<template>
  <div
    class="shell"
    :class="[`edge-${layout.edge}`, `is-${composition}`]"
    :style="{ '--interior-column-aspect': interiorColumnAspect }"
    @pointerdown.capture="raisePanel"
  >
    <!--
      The rail and the collapse arrow are one control in one component, because
      they are one surface in the design: the same #f6b644, with the arrow
      turned round.
    -->
    <EdgeRail :edge="layout.edge" :composition="composition" @toggle="toggleSecondary" />

    <template v-if="layout.expanded || layout.mineOpen">
      <div v-if="layout.expanded" class="shell-secondary">
        <!--
          The map container from the design: 21px padding on every side, a 2px
          #fae2b6 border and elevation 5, with the collected-materials totals
          overlaid in its upper-right corner (VaultChip, inside MapView).
        -->
        <PanelFrame v-if="viewState.area === 'map'" variant="map">
          <div v-if="loading" class="loading" role="status">
            <span class="spinner" aria-hidden="true"></span>
            <p>Scanning the hills for active agents...</p>
          </div>
          <MapView
            v-else
            :mines="state.mines"
            :tokens-observed="state.tokensObserved"
            :materials="state.materials"
            @open="enterMine"
          />
        </PanelFrame>

        <PanelFrame v-else-if="viewState.area === 'mines'">
          <MinesPanel
            :projects="projects"
            :mines="state.mines"
            :search="browseFilters.search"
            :tier="browseFilters.tier"
            :direction="browseFilters.direction"
            :loading="browseLoading"
            :error="browseError"
            :exhausted="browseExhausted"
            :adding="addingProject"
            :add-error="addProjectError"
            @search="setProjectSearch"
            @tier="setProjectTier"
            @toggle-direction="toggleProjectOrder"
            @load-more="loadMoreProjects"
            @add="addProject"
            @open="openFromBrowse"
          />
        </PanelFrame>

        <!--
          Settings, rebuilt to the design's own screen (#138): the heavy 4px
          frame is PanelFrame's 'settings' variant, and SettingsPanel draws
          everything specific to the screen — its title/divider, the
          shortcut/position/Data-Base sections, and the Application section
          #142 had nowhere else to put pin/hide/version.
        -->
        <PanelFrame v-else-if="viewState.area === 'settings'" variant="settings">
          <SettingsPanel
            :shortcut-state="shortcutState"
            :shortcut-error="shortcutError"
            :shortcut-recording="shortcutRecording"
            :shortcut-applying="shortcutApplying"
            :edge="layout.edge"
            :edge-applying="layoutApplying"
            :pinned="pinned"
            :pin-tooltip="pinTooltip"
            :version-text="versionText"
            :version-hint="versionHint"
            :resetting="metricsResetting"
            :reset-error="metricsResetError"
            @start-recording="startShortcutRecording"
            @stop-recording="stopShortcutRecording"
            @record="recordShortcut"
            @reset-shortcut="resetShortcut"
            @close="showMap"
            @select-edge="setEdge"
            @toggle-pin="togglePinned"
            @hide-panel="hidePanel"
            @reset-confirm="resetMetrics"
          />
        </PanelFrame>

        <PanelFrame v-else variant="settings">
          <UnavailablePanel :feature="viewState.area === 'lab' ? 'lab' : 'market'" />
        </PanelFrame>

        <p v-if="error" class="notice" role="alert">{{ error }}</p>
      </div>

      <!--
        The app mark hides the WINDOW (#156), which is the same hidePanel the
        global shortcut and Settings' own hide control already ask for. The
        layout is deliberately untouched: the panel that comes back is the one
        that went away, mine and page and all.
      -->
      <ShellNav
        :area="viewState.area"
        :broken="shortcutBroken"
        @select="selectArea"
        @hide="hidePanel"
      />

      <!--
        One mine beside AT MOST one secondary panel: the concurrent model the
        design's exports prove, and no more than that — the source warns in as
        many words against assuming arbitrary multi-panel stacking. The column
        follows the view's own open mine, as it always has; what main's
        `mineOpen` decides is whether this whole block is drawn, so the app mark
        can collapse the shell without the view forgetting its mine (#153).
      -->
      <div v-if="currentMine" class="shell-mine">
        <PanelFrame>
          <!--
            Keyed by the mine, so switching from one to another is a fresh
            scene rather than the same one handed different dwarfs (#153). The
            walk board tells an arrival from the opening crew by which snapshot
            it first saw them, and a reused board would parade a whole new
            crew across the interior every time the user changed mine.
          -->
          <MineScene
            :key="currentMine.id"
            :mine="currentMine"
            :arrived="state.arrived"
            :activating-id="activating"
            :send-states="messagingState.byDwarfId"
            :kick-states="kickingState.byDwarfId"
            :selected-id="openDwarfId"
            @back="leaveMine"
            @select="selectDwarf"
            @add="openLaunch(currentMine.id)"
            @history="openHistory"
          />
        </PanelFrame>
      </div>
    </template>

    <!--
      ONE dock, three panels (#86, #159, #192). The design's own transition is
      the Add Panel being REPLACED by the MessagePanel in the same place, so
      they share this slot rather than each having one — which is also why
      opening any of them puts the others away, in App and not in a component.
      The Mine History panel joins them here because the design floats it over
      the same ground while the mine stays visible, and two panels in one
      corner would cover each other.

      Held against the shell's FREE edge — the side away from the screen edge
      the window is docked to — which is where the design's own
      mine-and-message mock puts it relative to the mine.
    -->
    <div v-if="launchPhase !== 'closed' && launchPhase !== 'message-panel'" class="message-dock">
      <AddPanel
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
        @close="closeLaunchPanel"
      />
    </div>

    <!--
      Keyed by mine, so opening it on another mine is a fresh panel and a fresh
      default tab rather than a selection carried over from another folder.
    -->
    <div v-else-if="historyOpen && currentMine" class="message-dock">
      <MineHistoryPanel
        :key="currentMine.id"
        :mine="currentMine"
        :history="mineHistory"
        @close="closeHistory"
      />
    </div>

    <!--
      Keyed by dwarf, so selecting another one is a fresh panel: its opening
      height derives from the latest message and is taken once per open, which
      only holds if reopening is a genuine remount.
    -->
    <div v-else-if="selectedDwarf" class="message-dock">
      <DwarfMessagePanel
        :key="selectedDwarf.id"
        :dwarf="selectedDwarf"
        :feed="selectedFeed"
        :send-state="messagingState.byDwarfId[selectedDwarf.id]"
        :kick-state="kickingState.byDwarfId[selectedDwarf.id]"
        :answer-state="questionState.byDwarfId[selectedDwarf.id]"
        @send="sendText(selectedDwarf, $event)"
        @kick="kickDwarf(selectedDwarf)"
        @answer="answerQuestion(selectedDwarf, $event)"
        @open-console="activate(selectedDwarf)"
        @close="closeMessages"
      />
    </div>
  </div>
</template>

<style scoped>
/*
 * The shell is the whole window: a docked strip whose columns run from its free
 * edge to the screen edge it hangs on. A left-docked panel is the same DOM in
 * the other direction, which is what `row-reverse` buys — one order to reason
 * about, mirrored once.
 */
.shell {
  position: relative;
  display: flex;
  height: 100vh;
  overflow: hidden;
  color: var(--color-cream);
  font-size: var(--text-meta);
}
.shell.edge-left {
  flex-direction: row-reverse;
}
/*
 * The closed window is the platform's 32px floor rather than the design's 20px
 * rail, because Windows will not make one narrower (#153, MIN_WINDOW_WIDTH in
 * main/shell/panelBounds.ts). The rail itself is still 20px, held against the
 * DOCKED side so both edges look the same: `flex-end` is the right of a `row`
 * and the left of a `row-reverse`, which is exactly the docked side each time.
 */
.shell.is-rail {
  justify-content: flex-end;
}
/*
 * Both of the book's pages are drawn on the SAME shell (#156): the amber ground,
 * the 8px padding, the radius and the shadow belong to any composition that has
 * something in it, not only to the one with a secondary panel.
 *
 * The padding is load-bearing rather than decoration. main reserves it in the
 * window (SHELL_FRAME_WIDTH in main/shell/panelBounds.ts) and the mine column's
 * width is derived from the height it leaves, so a composition that skipped it
 * left the window 8px wider than the columns it drew — the void the acceptance
 * run photographed — and grew the painting into the difference.
 */
.shell.is-mine,
.shell.is-pages {
  gap: var(--space-nav-gap);
  padding: var(--space-nav-gap);
  border-radius: var(--radius-default);
  background: var(--color-rail);
  box-shadow: var(--elevation-5);
}
/*
 * Where the message panel sits (#159), and the honest reconciliation of the
 * design's 990px.
 *
 * The source's own mine-and-message mock draws the panel 1026px wide BESIDE
 * the shell on a 1350px screen — a second surface on the desktop, with the
 * mine untouched to its right. This app is one docked window, and only its
 * widest composition (a page and a mine, 1303 design px) has 990 to give; the
 * mine-only composition has 438. So the panel takes the design's width where
 * the composition has it and the composition's where it does not (see the
 * `min()` in DwarfMessagePanel), rather than hanging off the side of a window
 * that cannot grow for it.
 *
 * Held against the FREE edge — the side away from the screen edge the window
 * is docked to — which is the relation the mock draws: panel on one side, mine
 * on the other. `pointer-events` is handed back only to the panel itself, so
 * the strip beside it never swallows a click meant for the mine underneath.
 */
.message-dock {
  position: absolute;
  z-index: 60;
  right: var(--space-nav-gap);
  bottom: var(--space-nav-gap);
  left: var(--space-nav-gap);
  display: flex;
  justify-content: flex-start;
  pointer-events: none;
}
.shell.edge-left .message-dock {
  justify-content: flex-end;
}
.message-dock > * {
  pointer-events: auto;
}
.shell-secondary {
  position: relative;
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}
.shell-secondary > * {
  flex: 1;
  min-height: 0;
}
/*
 * The mine's own column, outboard of the navigation stack (see the exports).
 *
 * Its width is DERIVED, not declared (#153): the painting is drawn at the full
 * height of the shell's content area with its aspect preserved and nothing
 * cropped, so `aspect-ratio` on a full-height column is the whole rule — the
 * browser reads the height the flex row already gave it and answers with the
 * width. The design's 245px is what that returns at the mock's own 768-tall
 * composition; reserving 245 on a 1392-tall display is what made the interior
 * read tiny. main reserves the same number in the window; see mineColumnWidth
 * in main/shell/panelBounds.ts and interiorColumnWidth in lib/scene/sceneSizing.
 */
.shell-mine {
  position: relative;
  display: flex;
  flex: none;
  flex-direction: column;
  width: auto;
  height: 100%;
  aspect-ratio: var(--interior-column-aspect);
  min-width: 0;
}
.shell-mine > .panel-frame {
  flex: 1;
  min-height: 0;
}
.loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-settings);
  color: var(--color-tooltip-text);
}
.loading p {
  margin: 0;
}
.spinner {
  width: 25px;
  height: 25px;
  border: 3px solid var(--color-control);
  border-top-color: var(--color-accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
.notice {
  position: absolute;
  z-index: 90;
  right: var(--space-modal-margin);
  bottom: var(--space-modal-margin);
  left: var(--space-modal-margin);
  flex: none;
  margin: 0;
  padding: 9px var(--space-settings);
  border-left: 3px solid var(--danger-line);
  border-radius: var(--radius-default);
  color: var(--danger-ink);
  background: var(--danger-bg);
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
