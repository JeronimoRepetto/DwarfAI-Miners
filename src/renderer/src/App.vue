<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import MineHistoryPanel from './components/history/MineHistoryPanel.vue'
import EdgeRail from './components/shell/EdgeRail.vue'
import MapView from './components/map/MapView.vue'
import MineScene from './components/scene/MineScene.vue'
import MinesPanel from './components/browse/MinesPanel.vue'
import PanelFrame from './components/shell/PanelFrame.vue'
import PanelTransition from './components/shell/PanelTransition.vue'
import SettingsPanel from './components/panel/SettingsPanel.vue'
import ShellNav from './components/shell/ShellNav.vue'
import UnavailablePanel from './components/shell/UnavailablePanel.vue'
import { useAudio } from './composables/useAudio'
import { useDwarfDelivery } from './composables/useDwarfDelivery'
import { useMessagePanel } from './composables/useMessagePanel'
import { useMines } from './composables/useMines'
import { usePanelLayout } from './composables/usePanelLayout'
import { usePinnedWindow } from './composables/usePinnedWindow'
import { useShellFold } from './composables/useShellFold'
import { useProjectBrowse } from './composables/useProjectBrowse'
import { useResetMetrics } from './composables/useResetMetrics'
import { useToggleShortcut } from './composables/useToggleShortcut'
import { useView } from './composables/useView'
import { INTERIOR_ART_SIZE } from './lib/art'
import { shellComposition } from './lib/shell/composition'
import { unavailableAreaOf } from './lib/shell/shellNav'
import { versionLabel, versionTitle } from './lib/appBuild'
import type {
  AgentModelCatalog,
  AppBuild,
  Dwarf,
  DwarfTuningRequest,
  Mine,
  MineHistoryResult,
  MinesSnapshot,
  ShellArea
} from './types'

const { state, setMines } = useMines()
const { state: viewState, openMine, closeMine, showArea, showMap, syncWithMines } = useView()

/**
 * What the message panel's own window is showing (#162).
 *
 * The conversation left this window. The MessagePanel and the Add Panel — which
 * share one slot, because submitting a launch replaces the first with the
 * second — are a second BrowserWindow beside the shell now, the way the design
 * draws them, and everything they need to DO lives there with them: the launch,
 * the send, the kick, the answers, the observed session's transcript. See
 * MessagePanelWindow.vue.
 *
 * What is left here is the request and one reading. The shell asks for a
 * surface when a dwarf is clicked or the mine's Add action is pressed, and it
 * reads this state back to draw the selected dwarf's red halo — including for a
 * dwarf the shell never chose, because a launch handing over is something only
 * that window can know. Main holds the state for both.
 */
const {
  state: messagePanel,
  sync: syncMessagePanel,
  listen: listenMessagePanel,
  openMessage,
  openLaunch: openLaunchPanel,
  close: closeMessagePanel
} = useMessagePanel()

/**
 * The send and kick verdicts that window holds (#162), so the mine can draw
 * each one on the sprite it belongs to. Read-only here — see useDwarfDelivery.
 */
const { report: dwarfDelivery, listen: listenDwarfDelivery } = useDwarfDelivery()
const { pinned, sync: syncPinned, toggle: togglePinned } = usePinnedWindow()

/**
 * Everything the panel plays (#174, #173).
 *
 * Owned here for the reason the shortcut and the pin surfaces are: sound is
 * cross-cutting — the shell's own button starts it, Settings persists its
 * volumes, the mine interior mutes its ambience and a dwarf's click gives it a
 * voice — so the four surfaces read one engine rather than each opening one.
 * Nothing below this file decides anything about audio; see lib/audio/.
 */
const {
  settings: audioSettings,
  musicPlaying,
  ambienceMuted,
  sync: syncAudio,
  listen: listenAudio,
  toggleMusic,
  toggleAmbienceMute,
  setSettings: setAudioSettings,
  setScene: setAudioScene,
  setCollapsed: setAudioCollapsed,
  playVoice,
  playSfx,
  playCrew,
  dispose: disposeAudio
} = useAudio()

/**
 * The docked shell's own shape (#90). `layout` is only ever what MAIN reported,
 * because the window's rectangle is derived from the display: the rail's arrow
 * is drawn from `layout.edge`, and drawing it from a guess would point the user
 * off the screen.
 */
const {
  layout,
  visibleLayout,
  applying: layoutApplying,
  sync: syncLayout,
  apply: applyLayout,
  toggle: toggleLayout,
  setEdge
} = usePanelLayout(waitForPanelLeaves)

/**
 * The shell's own ground, and the fold that is now the panel's whole motion
 * (#388).
 *
 * The columns used to fade inside a window that then jumped to its new
 * rectangle in one frame — the pixels main added or removed were painted at the
 * moment they arrived or went, which is the flicker the issue reports. The
 * ground folds toward the docked edge instead, and main only ever resizes into
 * pixels that are already transparent: a shrink waits for the fold through the
 * same `waitForPanelLeaves` path a fade used to, and a grow starts the ground
 * clipped to the footprint it had. See composables/useShellFold.ts.
 */
const shellEl = ref<HTMLElement | null>(null)
const { hold: holdColumn, settle: settleShellFold } = useShellFold({
  shell: () => shellEl.value,
  edge: () => layout.value.edge,
  remaining: () => shellComposition(visibleLayout.value)
})

/*
 * `flush: 'post'` so the shell's box is the one main just made, and the
 * reservation is read off the disagreement itself: a layout wider than
 * presentation asked for is the swap holding the union of both compositions,
 * and unfolding into it would paint the pixels the fold is about to take back.
 *
 * All three sources, so that a request which ends without moving anything still
 * settles: a bridge that died mid-shrink leaves `layout` exactly as it was, and
 * a ground left folded under a window that never shrank reads as a panel that
 * collapsed by itself.
 */
watch(
  [layout, visibleLayout, layoutApplying],
  () =>
    settleShellFold(
      layout.value.expanded !== visibleLayout.value.expanded ||
        layout.value.mineOpen !== visibleLayout.value.mineOpen
    ),
  { flush: 'post' }
)

const panelLeaves = new Set<Promise<void>>()
function trackPanelLeave(completion: Promise<void>): void {
  panelLeaves.add(completion)
  const forget = (): void => void panelLeaves.delete(completion)
  // Settled either way, its say is spent. A rejected leave that stayed in the
  // set was waited on by every later shrink, and never answered any of them.
  completion.then(forget, forget)
}
async function waitForPanelLeaves(): Promise<void> {
  // Vue must first start every leaving column, including a dock closed by the
  // same mine change. Main keeps their last frame inside the window until then.
  await nextTick()
  // Taken as a BATCH and the set emptied: one leave that never reports
  // completion is asked once and never again, so it cannot wedge every shrink
  // after it (#266). `allSettled` for the same reason — a leave that threw has
  // still had its turn, and usePanelLayout bounds how long the turn lasts.
  const batch = [...panelLeaves]
  panelLeaves.clear()
  await Promise.allSettled(batch)
}

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
  removing: removingMine,
  removeError: removeMineError,
  load: loadProjects,
  loadMore: loadMoreProjects,
  setSearch: setProjectSearch,
  setTier: setProjectTier,
  toggleDirection: toggleProjectOrder,
  addProject,
  worktreeQuestion,
  openMainProject,
  dismissWorktreeQuestion,
  removeProject
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
 * The area the panel is on, when that area is one the design ships as
 * unavailable — the Lab, the Market, or the Laboral Union (#335).
 *
 * The list belongs to shellNav rather than to this template: `undefined` here
 * means the area has a screen of its own and one of the branches above draws it.
 */
const unavailableArea = computed(() => unavailableAreaOf(viewState.area))

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
  // The press answers back (#323). Before anything else it might do, so the
  // click is heard for a press that turns out to change nothing — pressing the
  // area already selected is still a press.
  playSfx('click')
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
 * Remove the mine a card asked about, once MinesPanel has had it confirmed
 * (#169).
 *
 * Nothing else to do here, and two things deliberately not done. The map is not
 * told: it draws the board, and the poll main publishes as part of the removal
 * no longer carries this mine. Neither is the mine held open beside the list —
 * `syncWithMines` already lets go of an open mine that has left the board, on
 * that same push, and a second path closing it here would be a rule with two
 * homes.
 */
function removeFromBrowse(projectId: string): void {
  void removeProject(projectId)
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
let unsubscribe: (() => void) | undefined
let unlistenMessagePanel: (() => void) | undefined
let unlistenDwarfDelivery: (() => void) | undefined
let unlistenAudio: (() => void) | undefined

/**
 * The dwarf the message panel is open on (#159, #162).
 *
 * At most one in the whole app, which is why it never lived in a sprite: the
 * design puts the panel beside the mine rather than beside the dwarf, so no
 * sprite can hold the fact that it is the selected one.
 *
 * READ from the state main holds rather than kept here, since #162. The panel
 * is another window now, and it is the one that learns which dwarf a launch
 * turned out to have started — so a local copy would be a second answer to a
 * question that already has one, and the halo would be drawn from the older of
 * the two.
 */
const openDwarfId = computed(() =>
  messagePanel.value.surface === 'message' && messagePanel.value.dwarfId !== ''
    ? messagePanel.value.dwarfId
    : null
)

/**
 * The mine's session strip needs a held session's own context reading, and
 * that is the one thing no poll ever volunteers (issue #96) — so main has to
 * be ASKED, once per subject: a mine opening on a dwarf already selected, and
 * every later selection, never a repeat for the same one on a poll that
 * changed nothing. `watch` already gives that for free — it fires only when
 * `openDwarfId` itself changes, so a poll that leaves the selection alone
 * never re-triggers it. What keeps the reading fresh AFTER that is main's own
 * pull at the end of each turn, not this watch.
 */
watch(openDwarfId, (dwarfId) => {
  if (dwarfId !== null) window.api.refreshDwarfTelemetry(dwarfId)
  // A refusal belongs to one session's own request (issue #96). Carried over
  // to the next selection it would read as a refusal from the dwarf the
  // reader has only just picked, which is a claim about a session nobody
  // asked anything of.
  tuningRefusal.value = undefined
})

/**
 * What each provider can run, for the strip's model select (issue #96) —
 * #239's own catalogue channel, reused rather than asked a second time, so
 * there is exactly one answer in this app to "what can a session switch to".
 *
 * Asked ONCE per run, lazily, the first time a mine is opened. Both halves of
 * that matter and neither is a guess: the ask spawns a real CLI process per
 * provider (see `createSdkModelCatalog`), so it must not ride a selection, a
 * mine, or the 2 Hz poll — and nothing outside a mine can draw the strip, so
 * paying for it at startup would charge every run that never opens one. What
 * a machine has installed changes when somebody installs a CLI, which is not
 * something to keep in step within one run of a floating panel.
 */
const catalogs = ref<readonly AgentModelCatalog[]>([])
let catalogsAsked = false

/** Why the last tuning change was refused, until the strip changes subject. */
const tuningRefusal = ref<string | undefined>(undefined)

watch(
  () => viewState.mineId,
  (mineId) => {
    if (mineId === null || catalogsAsked) return
    catalogsAsked = true
    void window.api
      .listAgentModels()
      .then((list) => {
        catalogs.value = list.catalogs
      })
      .catch(() => {
        // A catalogue nobody could answer is a strip with no select on it,
        // which is what an unanswered one already looks like — and it is the
        // honest rendering, so there is nothing to report here.
      })
  }
)

/**
 * Ask main to change a held session's model or effort (issue #96).
 *
 * The one place in the renderer that talks to main about this. The scene and
 * the strip decide and draw; neither reaches the bridge, for the reason the
 * send and kick verdicts already live up here — a control's verdict has to be
 * shown beside the control, and the surface below it is redrawn from every
 * poll.
 *
 * `applied: true` is deliberately NOT acted on. It means the session accepted
 * the request, not that anything changed, and what changed arrives on a later
 * snapshot as the session's own report (see `DwarfSessionTuning`). Drawing
 * anything off this verdict would be the panel claiming a change on the
 * strength of having asked for one.
 */
async function tuneSession(request: DwarfTuningRequest): Promise<void> {
  tuningRefusal.value = undefined
  const verdict = await window.api.setDwarfTuning(request)
  if (!verdict.applied) tuningRefusal.value = verdict.reason
}

/*
 * WHAT WENT WITH THE PANEL (#162).
 *
 * The observed session's transcript and everything around it — `selectedFeed`,
 * its token, the dwarf it answers for, the pushed-feed signal (#196), the
 * shrink log (#249) and both re-read watches (#183, #195) — moved to
 * MessagePanelWindow.vue, whole. They belong to the surface that shows the
 * words, and that surface is a window of its own; reading a transcript here to
 * push it across a process boundary would be a round trip for nothing.
 *
 * `setWatchedDwarf` went with them for the same reason: it is the panel saying
 * which dwarf it has open, and it is no longer this window that knows.
 */

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
  /*
   * The panel's own sound, both ways (#323), fired HERE rather than off the
   * layout that comes back: this is the one place the secondary panel's state
   * is flipped, so it is once per transition however many controls lead to it,
   * and the press is what the sound is answering. It plays before the layout
   * has been asked for on purpose — a press whose sound waited for main would
   * be feedback arriving after the animation it belongs to, and opening from
   * the rail is the press the collapse gate is exempted for (see volume.ts).
   */
  playSfx('panel')
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

/** Clicking the selected dwarf again closes its panel, as a toggle should. */
function selectDwarf(dwarf: Dwarf): void {
  // The dwarf speaks (#173), and a click on a dwarf is the ONLY thing that
  // makes one speak. Before the toggle below, deliberately: clicking the
  // selected dwarf again closes its panel and is still a click on the dwarf.
  playVoice(dwarf.role)
  // The mine's own History panel still shares the shell's dock, and one
  // conversation surface at a time is the rule whether or not the two overlap
  // any more: opening this puts that away.
  historyOpen.value = false
  if (openDwarfId.value === dwarf.id) {
    void closeMessagePanel()
    return
  }
  // Naming the mine as well as the dwarf, because the panel window is opened
  // on a surface rather than handed a selection: the Add Panel that shares its
  // slot needs the mine, and a message panel that could not name one would be
  // a window with no way back to the board it came from.
  if (viewState.mineId !== null) void openMessage(viewState.mineId, dwarf.id)
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

/** The mine's History action (#192): one conversation surface at a time (#162). */
function openHistory(): void {
  void closeMessagePanel()
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
 * The refusal main gave for the LAST History path click (#279), keyed by the
 * row so it can only ever land on the row that was clicked — see
 * MineHistoryPanel's own `pathRefusal` prop. This panel has no status line of
 * its own, unlike the message panel, so the refusal shows on the row itself.
 */
const historyPathRefusal = ref<{ key: string; reason: string } | undefined>(undefined)

/**
 * Open an activity line's own path from the History panel (#279). Resolved
 * and verified entirely in main, against the open mine's own folder — this
 * window only relays the click and hands the verdict back to the row that
 * asked for it.
 */
async function openHistoryPath(payload: { key: string; target: string }): Promise<void> {
  if (currentMine.value === undefined) return
  historyPathRefusal.value = undefined
  try {
    const result = await window.api.openMinePath({
      mineId: currentMine.value.id,
      target: payload.target
    })
    if (!result.opened) historyPathRefusal.value = { key: payload.key, reason: result.reason }
  } catch {
    historyPathRefusal.value = { key: payload.key, reason: 'That file could not be opened.' }
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
 * What the ambience is a reading of (#173), and since #330 it is the mine held
 * open and nothing else.
 *
 * It used to fold each of the crew's rank and status into the signal, because
 * the bed was a reading of what the crew was doing. The crew sounds for itself
 * now — cue by cue, off the frames each sprite draws, arriving through
 * `playCrew` below — so what is left for the scene to decide is the room tone,
 * and a poll that moves a dwarf's status no longer touches the sound at all.
 */
watch(() => viewState.mineId, setAudioScene, { immediate: true })

/*
 * The shell collapsed to its bare rail silences the ambience and the voices
 * and leaves the music playing (#174). Read off the composition rather than
 * off `expanded`, for the reason that flag could not carry the mine-only
 * composition either (see lib/shell/composition.ts).
 */
watch(composition, (shape) => setAudioCollapsed(shape === 'rail'), { immediate: true })

/**
 * The mine's Add action (#86).
 *
 * Re-opening the panel already open on this mine is left alone rather than
 * treated as a toggle: `open()` starts a fresh panel, so a second click would
 * silently discard a prompt somebody was half-way through typing. That guard
 * moved to the panel window with the launch itself (#162) — it is the side
 * that knows whether a prompt is half typed. The panel has its own close, and
 * Escape.
 */
function openLaunch(mineId: string): void {
  historyOpen.value = false
  void openLaunchPanel(mineId)
}

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
    // Closes whatever the panel window has open, the launch included: a launch
    // whose mine went away has nowhere to put the dwarf it is waiting for.
    if (messagePanel.value.surface !== 'none') void closeMessagePanel()
  }
)

/*
 * WHAT WENT WITH THE PANEL, PART TWO (#162): `activate` (bringing a session's
 * own console forward, and the sentence said when it could not be), `sendText`
 * and `deliverText`, `kickDwarf`, `answerQuestion` and `decidePermission`.
 *
 * Every one of them was the panel acting on the dwarf it had open, so all six
 * moved to the window that now holds that panel. The verdicts come back here
 * as `dwarfDelivery`, because the marker they draw is on the sprite.
 *
 * REMOVED with them, stated rather than passing unseen: MineScene's
 * `activatingId` prop, which dimmed a sprite while its console was being
 * raised. The click that starts that is in the other window now, so dimming a
 * sprite here would be feedback in the place nobody is looking; the panel says
 * out loud when the console could not be opened, which is the part that
 * mattered. DwarfSprite keeps its own `activating` prop and its test — nothing
 * feeds it today, and reviving it would mean publishing the activation the way
 * the delivery verdicts are published.
 */

onMounted(() => {
  // The footprint the first opening unfolds from: whatever rectangle main
  // created the window at, which is the rail unless a past run left it open.
  settleShellFold(false)
  void load()
  // The map draws every remembered project, not only the live board (#197),
  // and the map is the DEFAULT area — a read gated on visiting Mines first
  // left the common case (open the panel, look at the map) stuck on the
  // board alone. One read at startup, beside the mines poll, is enough:
  // `selectArea` below still re-reads on every Mines visit to stay fresh.
  void loadProjects()
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
  // Adopts the stored Audio settings and the window's REAL visibility, then
  // starts the music if the settings say it should be playing (#174).
  void syncAudio()
  // Hears the window being shown or hidden, and gives the engine its tick.
  unlistenAudio = listenAudio()
  unsubscribe = window.api.onMinesUpdated(update)
  // Listening BEFORE the pull, deliberately: the panel window can change what
  // it is showing at any moment, and a state set between the two would
  // otherwise be the one change the halo never heard.
  unlistenMessagePanel = listenMessagePanel()
  void syncMessagePanel()
  unlistenDwarfDelivery = listenDwarfDelivery()
})
onBeforeUnmount(() => {
  unsubscribe?.()
  unlistenMessagePanel?.()
  unlistenDwarfDelivery?.()
  unlistenAudio?.()
  // Every sound released with the window: a clip left decoding would outlive
  // the surface that asked for it.
  disposeAudio()
})
</script>

<template>
  <div
    ref="shellEl"
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

    <!--
      The three columns of the book hand their motion to the ground they stand
      on (#388): `hold` is the shell's own fold, and each column is only
      RETAINED here until it ends — unmounting one before main has shrunk the
      window would repack the row inside a rectangle that has not changed yet.
      The area switch inside the page and the history dock below still animate
      themselves: both already move within bounds nothing is resizing.
    -->
    <PanelTransition :hold="holdColumn" @leave="trackPanelLeave">
      <div v-if="visibleLayout.expanded" class="shell-secondary">
        <PanelTransition @leave="trackPanelLeave">
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
              :projects="projects"
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
              :removing="removingMine"
              :remove-error="removeMineError"
              :worktree-question="worktreeQuestion"
              @search="setProjectSearch"
              @tier="setProjectTier"
              @toggle-direction="toggleProjectOrder"
              @load-more="loadMoreProjects"
              @add="addProject"
              @open="openFromBrowse"
              @remove="removeFromBrowse"
              @open-main-project="openMainProject"
              @dismiss-worktree="dismissWorktreeQuestion"
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
              :audio-settings="audioSettings"
              @start-recording="startShortcutRecording"
              @stop-recording="stopShortcutRecording"
              @record="recordShortcut"
              @reset-shortcut="resetShortcut"
              @close="showMap"
              @select-edge="setEdge"
              @toggle-pin="togglePinned"
              @hide-panel="hidePanel"
              @reset-confirm="resetMetrics"
              @audio-change="setAudioSettings"
            />
          </PanelFrame>

          <!--
            The Lab, the Market and the Laboral Union (#335): one overlay for the
            three areas the design ships as unavailable, keyed so switching
            between them re-enters the transition rather than swapping the
            painting under a still frame. `v-else-if` rather than `v-else`,
            because an area with no screen and no unavailable painting should
            draw nothing instead of borrowing another hall's sentence.
          -->
          <PanelFrame v-else-if="unavailableArea" :key="viewState.area" variant="settings">
            <UnavailablePanel :feature="unavailableArea" />
          </PanelFrame>
        </PanelTransition>

        <p v-if="error" class="notice" role="alert">{{ error }}</p>
      </div>
    </PanelTransition>

    <!--
        The app mark hides the WINDOW (#156), which is the same hidePanel the
        global shortcut and Settings' own hide control already ask for. The
        layout is deliberately untouched: the panel that comes back is the one
        that went away, mine and page and all.
      -->
    <PanelTransition :hold="holdColumn" @leave="trackPanelLeave">
      <ShellNav
        v-if="visibleLayout.expanded || visibleLayout.mineOpen"
        :area="viewState.area"
        :broken="shortcutBroken"
        :music-playing="musicPlaying"
        @select="selectArea"
        @hide="hidePanel"
        @toggle-music="toggleMusic"
      />
    </PanelTransition>

    <!--
        One mine beside AT MOST one secondary panel: the concurrent model the
        design's exports prove, and no more than that — the source warns in as
        many words against assuming arbitrary multi-panel stacking. The column
        follows the view's own open mine, as it always has; what main's
        `mineOpen` decides is whether this whole block is drawn, so the app mark
        can collapse the shell without the view forgetting its mine (#153).
      -->
    <PanelTransition :hold="holdColumn" @leave="trackPanelLeave">
      <div v-if="visibleLayout.mineOpen && currentMine" class="shell-mine">
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
            :send-states="dwarfDelivery.send"
            :kick-states="dwarfDelivery.kick"
            :selected-id="openDwarfId"
            :catalogs="catalogs"
            :tuning-refusal="tuningRefusal"
            :ambience-muted="ambienceMuted"
            @back="leaveMine"
            @select="selectDwarf"
            @add="openLaunch(currentMine.id)"
            @history="openHistory"
            @tune="tuneSession"
            @toggle-ambience-mute="toggleAmbienceMute"
            @crew-sound="playCrew"
          />
        </PanelFrame>
      </div>
    </PanelTransition>

    <!--
      The mine's History panel, and it is what is LEFT of the dock (#162).

      The MessagePanel and the Add Panel used to share this slot; they are a
      window of their own now, beside the shell, which is how the design draws
      all three. This one stayed because #162 asked for those two — the same
      mock does put the history panel out here as well, so moving it is the
      obvious follow-up rather than something this slot is right about.

      Opening it still closes the panel window and being selected still closes
      it, even though the two no longer overlap: one conversation surface at a
      time is a rule about attention, not about geometry.
    -->
    <PanelTransition axis="vertical" @leave="trackPanelLeave">
      <!--
        Keyed by mine, so opening it on another mine is a fresh panel and a fresh
        default tab rather than a selection carried over from another folder.
      -->
      <div
        v-if="historyOpen && currentMine"
        :key="`history:${currentMine.id}`"
        class="message-dock"
      >
        <MineHistoryPanel
          :key="currentMine.id"
          :mine="currentMine"
          :history="mineHistory"
          :path-refusal="historyPathRefusal"
          @close="closeHistory"
          @open-path="openHistoryPath"
        />
      </div>
    </PanelTransition>
  </div>
</template>

<style scoped>
/*
 * The shell is the whole window: a docked strip whose columns run from its free
 * edge to the screen edge it hangs on. A left-docked panel is the same DOM in
 * the other direction, which is what `row-reverse` buys — one order to reason
 * about, mirrored once.
 *
 * Its ground is also the surface the whole panel's motion is drawn on (#388):
 * `clip-path` is set on this element, from useShellFold, and folds it toward
 * the docked edge so main only ever resizes the window into pixels that are
 * already transparent. Nothing here declares it — a clip left in the
 * stylesheet would be a second opinion about how wide the shell is — but every
 * rule below is inside it, the shadow and the radius included.
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
  --panel-motion-x: -12px;
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
 * Where the mine's History panel sits — all that is left of this dock (#162).
 *
 * It used to hold three panels and the honest reconciliation of the design's
 * 990px with a window that could not grow for it: the mock draws the panel
 * BESIDE the shell, this app was one docked window, and only its widest
 * composition had 990 design pixels to give. That reconciliation is gone with
 * the compromise it belonged to — the MessagePanel and the Add Panel have a
 * window of their own now (see main/shell/panelBounds.ts) and take the
 * design's width beside the shell, not inside it.
 *
 * The history panel is still `min(990px, 100%)` of this strip, which is the
 * same compromise for the one surface #162 did not move. Held against the FREE
 * edge — the side away from the screen edge the window is docked to — which is
 * the relation the mock draws: panel on one side, mine on the other.
 * `pointer-events` is handed back only to the panel itself, so the strip beside
 * it never swallows a click meant for the mine underneath.
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
.shell-secondary > .panel-frame {
  position: absolute;
  inset: 0;
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
