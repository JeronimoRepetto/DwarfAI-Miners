<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
  type ComponentPublicInstance
} from 'vue'
import { MotionConfig } from 'motion-v'
import HistoryPanel from './components/history/HistoryPanel.vue'
import AddPanel from './components/launch/AddPanel.vue'
import DwarfMessagePanel from './components/message/DwarfMessagePanel.vue'
import MapPage from './components/map/MapPage.vue'
import MineColumn from './components/scene/MineColumn.vue'
import MinesList from './components/browse/MinesList.vue'
import ToastHost from './components/overlay/ToastHost.vue'
import StopEverythingConfirmation from './components/stopEverything/StopEverythingConfirmation.vue'
import HostStateMessage from './components/hostConnection/HostStateMessage.vue'
import PanelTransition from './components/shell/PanelTransition.vue'
import SettingsPanel from './components/panel/SettingsPanel.vue'
import PanelNav from './components/shell/PanelNav.vue'
import GuildPage from './components/shell/GuildPage.vue'
import { useAudio } from './composables/useAudio'
import { useMessageDock } from './composables/useMessageDock'
import { useMines } from './composables/useMines'
import { useMapTime } from './composables/useMapTime'
import { usePanelLayout } from './composables/usePanelLayout'
import { usePinnedWindow } from './composables/usePinnedWindow'
import { useShellFold } from './composables/useShellFold'
import type { MotionAnimate } from './lib/shell/boundedMotion'
import { useProjectBrowse } from './composables/useProjectBrowse'
import { useToasts } from './composables/useToasts'
import { createAttentionWatch } from './lib/audio/attentionCues'
import { browseRows } from './lib/browse/boardRows'
import { createBrowseRefresh } from './lib/browse/browseRefresh'
import { columnMine, launchMineOpens, openableMineIds } from './lib/browse/columnMine'
import { mineCardView, mineRefusalToast } from './lib/browse/mineCard'
import { removedToast, sortToast, type MineSort } from './lib/browse/minesList'
import { useResetMetrics } from './composables/useResetMetrics'
import { useStopEverything, type StopEverythingDwarf } from './composables/useStopEverything'
import { useToggleShortcut } from './composables/useToggleShortcut'
import { takeLaunchMine, useView } from './composables/useView'
import { useNotificationSettings } from './composables/useNotificationSettings'
import { useJevSettings } from './composables/useJevSettings'
import { useOpenCodeSettings } from './composables/useOpenCodeSettings'
import { useTypography } from './composables/useTypography'
import { useHostConnection } from './composables/useHostConnection'
import { INTERIOR_ART_SIZE } from './lib/art'
import {
  MINE_COLUMN_ART_INSET,
  MINE_COLUMN_CHROME_HEIGHT,
  MINE_COLUMN_MIN_WIDTH,
  SHELL_CONTENT_INSET
} from './lib/scene/sceneSizing'
import { prefersReducedMotion, watchReducedMotion } from './lib/scene/sceneMotion'
import { REDUCED_MOTION_TRANSITION } from './lib/shell/presence'
import { dockReplaceMotion, dockWindowMotion } from './lib/shell/dockMotion'
import { mineOnScreen } from './lib/shell/mineOnScreen'
import { unavailableAreaOf } from './lib/shell/shellNav'
import { needsYouCount, reachableArea } from './lib/shell/panelNav'
import { versionLabel, versionTitle } from './lib/appBuild'
import type {
  AppBuild,
  Dwarf,
  FeatureFlags,
  Mine,
  MineHistoryResult,
  MinesSnapshot,
  ShellArea
} from './types'

const props = defineProps<{
  /**
   * The engine `createBoundedMotion` runs, for a test to hand in a
   * hand-written fake — production never sets this (`main.ts` mounts this
   * component with no props at all), and gets the real motion-v import
   * (#566). Threaded to `useShellFold` and every `PanelTransition` below,
   * which is the whole of what this shell animates.
   */
  engine?: MotionAnimate
}>()

/**
 * Whether this viewer asked their operating system for less movement (#71),
 * read and watched the same way the old `DwarfSprite` did — the one query
 * lives in `sceneMotion`, and this is a second place that asks it rather
 * than a second query, the same relationship `boundedMotion.ts`'s own
 * `still()` and `PanelTransition`'s watch already have with it.
 *
 * Fed to `<MotionConfig>` below (#566 T3): it governs every `AnimatePresence`
 * / `motion.*` surface under this root (the modals and popups T3 adds), and
 * nothing the bounded runner drives — `PanelTransition`, `useShellFold` and
 * the message surface read `sceneMotion` on their own, unchanged by this.
 */
const reduced = ref(prefersReducedMotion())
const stopWatchingReducedMotion = watchReducedMotion((asked) => {
  reduced.value = asked
})
onBeforeUnmount(stopWatchingReducedMotion)

const { state, setMines } = useMines()
/** The painting the Map page wears, by the time of day (#136). */
const mapVariant = useMapTime()
const { state: viewState, openMine, closeMine, showArea, showMap, syncWithMines } = useView()

/**
 * The MessagePanel and the Add panel, anchored in the dock's window slot (#635).
 *
 * AMENDED for #635 (was: a second BrowserWindow beside the shell, #162, whose surface main held
 * for both windows and whose delivery verdicts were published back here). The decision log
 * anchors both panels in the Panel, and the PO chose one OS window for it (2026-09-27), so the
 * slot the history stands in holds them too, one thing at a time. Everything they DO — the
 * launch, the send, the kick, the answers, the observed session's feed, one draft per dwarf — is
 * useMessageDock's, alive as long as this shell is; the halo and the sprite markers read it here.
 */
const dock = useMessageDock()
const { close: closeMessagePanel } = dock

/**
 * The control that opened what the dock's window slot holds (#635): "+ Dwarf" for the Add panel,
 * the pressed dwarf for its chat. Esc closes the topmost layer and focus returns to whatever
 * opened it (accessibility.md, Focus), and keyboard focus is never dropped to the page: the panel
 * that had it is gone, so the opener takes it back. Remembered at the press, before the panel
 * takes the keyboard for itself; a launch handing over to its dwarf's chat keeps the one it had.
 */
let dockOpener: HTMLElement | null = null
/** Whether that opener was pressed with the pointer, so taking the keyboard back draws no ring. */
let dockOpenerPressed = false

/**
 * The button a pointer press is on, until a key is pressed. A dwarf takes no focus from a mouse
 * press (`@mousedown.prevent`, so its ring shows only for the keyboard), which leaves the focused
 * element wherever it was: for a pointer gesture the pressed button is the opener, not the focus.
 */
let pressedButton: HTMLElement | null = null

function notePress(event: PointerEvent): void {
  const target = event.target
  pressedButton = target instanceof Element ? target.closest<HTMLElement>('button') : null
}

function forgetPress(): void {
  pressedButton = null
}

function rememberDockOpener(): void {
  const pressed = pressedButton
  pressedButton = null
  if (pressed !== null && pressed.isConnected) {
    dockOpener = pressed
    dockOpenerPressed = true
    return
  }
  const active = document.activeElement
  dockOpener = active instanceof HTMLElement && active !== document.body ? active : null
  dockOpenerPressed = false
}

/** The panels' own close, Esc among it: the slot empties and the opener takes the keyboard back. */
function closeDockToOpener(): void {
  const opener = dockOpener
  const focusVisible = !dockOpenerPressed
  dockOpener = null
  closeMessagePanel()
  // The opener may have been redrawn away since; a control no longer in the page takes nothing.
  if (opener !== null) void nextTick(() => opener.isConnected && opener.focus({ focusVisible }))
}
const dwarfDelivery = dock.delivery
const { pinned, sync: syncPinned, toggle: togglePinned } = usePinnedWindow()

/* --- System notifications (#316) — one block, appended --------------------- */
/**
 * Settings' notifications switch (#316).
 *
 * A reading and never an authority: main is the process that raises a
 * notification, so it owns the switch and this only draws what it answered
 * with — the rule `usePinnedWindow` holds for the pin.
 */
const {
  enabled: notificationsEnabled,
  sync: syncNotifications,
  set: setNotificationsEnabled
} = useNotificationSettings()
/* --- end of the #316 block ------------------------------------------------- */

/* --- Jev launch routing: the API key setting (#509) — one block, appended - */
/**
 * Settings' Jev API-key control (#509).
 *
 * A reading and never an authority, the same rule `useNotificationSettings`
 * holds for its switch: main is the only process that ever sees the
 * plaintext key, so this only draws what it answered with. The key itself
 * never lives here — `setJevApiKey` hands the preload the typed value and
 * this composable only ever keeps what main STORED, `configured`/
 * `unavailableReason`.
 */
const {
  settings: jevSettings,
  saving: jevSaving,
  providers: jevProviders,
  catalogs: jevCatalogs,
  sync: syncJevSettings,
  save: saveJevApiKey,
  clear: clearJevApiKey,
  setPreferences: setJevPreferences
} = useJevSettings()
/* --- end of the #509 block ------------------------------------------------- */

/* --- OpenCode permission relay: consent and server password (#588 T6) — one block, appended --- */
/**
 * Settings' OpenCode section (#588 T6). A reading and never an authority:
 * main owns the relay and the only copy of the password, so this draws only
 * what main answered with — the password is handed to the preload and never
 * kept here.
 */
const {
  settings: openCodeSettings,
  applying: openCodeApplying,
  sync: syncOpenCodeSettings,
  setPluginEnabled: setOpenCodePluginEnabled,
  savePassword: saveOpenCodeServerPassword,
  clearPassword: clearOpenCodeServerPassword
} = useOpenCodeSettings()
/* --- end of the #588 T6 block ------------------------------------------------ */

/* --- Typography preferences (#370) — one block, appended ------------------- */
/**
 * Which faces the app is drawn in (#370).
 *
 * Owned here because Settings is here, and installed in the OTHER root as well
 * — the composable repoints two custom properties on its own document, so each
 * window paints itself and neither has to hear about the other's components.
 */
const {
  preferences: typography,
  applying: typographyApplying,
  sync: syncTypography,
  set: setTypography,
  listen: listenTypography
} = useTypography()
/* --- end of the #370 block ------------------------------------------------- */

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
  playVoice,
  playSfx,
  playCrew,
  dispose: disposeAudio
} = useAudio()

/**
 * The attention cues (#635): every snapshot, however it arrived, goes through
 * one watch, which answers the cues whose state BEGAN since the last one — never
 * a state that was already pending at launch or merely re-polled. The engine
 * decides whether each is heard (Notification sounds, the hidden window).
 */
const attentionWatch = createAttentionWatch()

/**
 * The docked shell's own shape (#90). `layout` is only ever what MAIN reported,
 * because the window's rectangle is derived from the display: the columns and
 * the dock slot are drawn into width main gave the window, and drawing them from
 * a guess would paint into width it does not have.
 */
const {
  layout,
  visibleLayout,
  applying: layoutApplying,
  sync: syncLayout,
  apply: applyLayout,
  setEdge
} = usePanelLayout(waitForPanelLeaves)

/**
 * The shell's own ground, and the fold that moves it when the mine column opens
 * or closes (#388).
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
/** The plate's `.m-mat` edge, one art pixel (--px) outside its box (#635). */
const PLATE_OUTLINE = 2
/*
 * `railEl` stood here until #635: the closed rail, which travelled with the fold
 * (#464). The rail is gone (PO ruling 2026-09-27).
 *
 * The page travels with the fold whenever the mine column is what closes or
 * opens beside it (#566 T5b): it stands on the mine column's free side.
 * `secondaryEl` is a plain element's own ref.
 *
 * The nav is no longer carried (#635). It stands at the screen edge now, docked
 * of every other column, so nothing that leaves or arrives is ever between it
 * and the edge: "opening or closing a mine never moves the nav" is the design's
 * rule and this is the fold keeping it. It is still named as the strip, the
 * wall a drawer goes behind — the mine column slides out from behind it now.
 * `navEl` reads the nav's root guarded rather than asserted, because a
 * component ref answers an instance, not a node, and a fold is what a shrink
 * waits on — it may lose the travel, never the shrink.
 */
const secondaryEl = ref<HTMLElement | null>(null)
const navEl = ref<ComponentPublicInstance | null>(null)
const {
  hold: holdColumn,
  enter: enterColumn,
  settle: settleShellFold
} = useShellFold({
  shell: () => shellEl.value,
  edge: () => layout.value.edge,
  // The plate's 2px edge is drawn outside the shell's box (#635), so the fold
  // leaves it room.
  outline: () => PLATE_OUTLINE,
  // The strip is named as well as carried (#585 round 3): it is the wall a
  // drawer goes behind, and the one column whose room a drawer never follows.
  strip: () => (navEl.value?.$el instanceof HTMLElement ? navEl.value.$el : null),
  carried: () => [secondaryEl.value],
  /*
   * The layout queue's own flag, which the fold reads as "not yet" (#585): the
   * browser's `resize` for a grow arrives before Vue has mounted the columns
   * that same request brings, and an unfold measured there reveals bare
   * ground. `usePanelLayout` holds it for exactly one request and clears it in
   * a `finally`, so nothing can strand the fold behind a request that broke.
   */
  applying: () => layoutApplying.value,
  engine: props.engine
})

/*
 * `flush: 'post'` so the shell's box is the one main just made, and the
 * reservation is read off the disagreement itself: a layout wider than
 * presentation asked for is the swap holding the union of both compositions,
 * and unfolding into it would paint the pixels the fold is about to take back.
 *
 * TWO sources, where there were three: `layoutApplying` was the third, and the
 * request it was there for — a bridge that died mid-shrink, leaving the ground
 * folded under a window that never shrank — reaches these two anyway. Nothing
 * clips the ground until a column starts leaving, and a column starts leaving
 * because `send` assigned `visibleLayout` a FRESH object; every way out of that
 * assigns it again, the success path to what main reported and the failure to
 * `sync()`, which sets `visibleLayout` from `layout` whether or not the re-read
 * answered. What the flag added on top was one settle on `applying` flipping
 * true — a whole IPC round trip before anything had moved, so a no-op by
 * construction, and two of them on a swap (#396).
 */
/*
 * AMENDED for #635: the reservation is read off `mineOpen` alone. The dock slot
 * stands beside the plate rather than on it, so a window reserved for the slot
 * is not width the ground is folding in or out of.
 */
watch(
  [layout, visibleLayout],
  () => settleShellFold(layout.value.mineOpen !== visibleLayout.value.mineOpen),
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

/*
 * `composition` stood here until #635: which of the rail, the mine alone and the
 * pages was on screen (#156). The rail and the mine-alone composition it made
 * are gone (PO ruling 2026-09-27), so the shell always paints its plate, the
 * nav and the page; lib/shell/composition.ts went with them.
 */

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
  adding: addingProject,
  addError: addProjectError,
  removing: removingMine,
  removeError: removeMineError,
  load: loadProjects,
  refresh: refreshProjects,
  setSearch: setProjectSearch,
  setTier: setProjectTier,
  setSort: setProjectSort,
  addProject,
  worktreeQuestion,
  openMainProject,
  dismissWorktreeQuestion,
  removeProject
} = useProjectBrowse()
// Reads the list again while Mines is on screen when the board shows a measurement it lacks (#635).
const browseRefresh = createBrowseRefresh()

/**
 * A shortcut the OS refused is flagged on the navigation stack's Settings
 * button, without anything being opened: a failure the user only meets after
 * opening settings is a failure they never look for. It was flagged on the old
 * titlebar's gear, which the design replaced.
 */
const shortcutBroken = computed(
  () => shortcutState.value !== null && !shortcutState.value.registered
)

/* --- Features that ship hidden (#635) — one block, appended --------------- */
/**
 * The features that ship hidden, as main resolved them from configuration.
 *
 * Off until main answers, and off for good if the read fails: a flag is the
 * permission to show something, and a bridge that could not say so has not
 * given it. Read once, like the build — nothing changes it while main lives.
 */
const featureFlags = ref<FeatureFlags>({ guildAreasEnabled: false })

async function loadFeatureFlags(): Promise<void> {
  try {
    featureFlags.value = await window.api.getFeatureFlags()
  } catch {
    // Nothing to fall back on but the closed default, which is what stands.
  }
}

/**
 * The page the shell shows: the view's own area, unless that is a guild area
 * while the guild areas are hidden — nothing may point at them then, so the
 * view shows the map instead (see `reachableArea`).
 */
const page = computed(() => reachableArea(viewState.area, featureFlags.value.guildAreasEnabled))

/** How many dwarfs need you, on the nav's Mines slot (screens/shell.md, W1·10). */
const needsYou = computed(() => needsYouCount(state.mines))
/* --- end of the #635 block ------------------------------------------------- */

/**
 * The area the panel is on, when that area is one the design ships as
 * unavailable — the Lab, the Market, or the Laboral Union (#335).
 *
 * The list belongs to shellNav rather than to this template: `undefined` here
 * means the area has a screen of its own and one of the branches above draws it.
 */
const unavailableArea = computed(() => unavailableAreaOf(page.value))

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
 * Remove the mine a card asked about, once the Mines page has had it confirmed (#169), and say it
 * happened ("<name> removed", screens/browse.md).
 *
 * Nothing else to do here, and two things deliberately not done. The map is not told: it draws
 * the board, and the poll main publishes as part of the removal no longer carries this mine.
 * Neither is the mine held open beside the list — `syncWithMines` already lets go of an open mine
 * that has left the board, on that same push, and a second path closing it here would be a rule
 * with two homes.
 */
async function removeFromBrowse(projectId: string): Promise<void> {
  const name = projects.value.find((project) => project.id === projectId)?.name ?? projectId
  if (await removeProject(projectId)) showToast(removedToast(name))
}

/* --- The Mines page (#635) — one block, appended ------------------------- */
const { showToast } = useToasts()

/**
 * Every mine as its card, built once per change of the list or the board: the page filters and
 * orders them itself, so the board rows are joined unfiltered (lib/browse/boardRows.ts).
 */
const mineCards = computed(() =>
  browseRows(projects.value, state.mines, { search: '', tier: null }).map((row) =>
    mineCardView(row, state.mines)
  )
)

/*
 * A press on a mine that cannot be entered (PANEL-QUESTIONS 6): nothing opens, and a toast says
 * why, "<name>: <reason>", with the warning icon, from the Mines page and the map alike.
 */
function refuseMine(projectId: string): void {
  const name = projects.value.find((project) => project.id === projectId)?.name ?? projectId
  showToast(mineRefusalToast(name), 'warning')
}

function sortProjects(mode: MineSort): void {
  setProjectSort(mode)
  showToast(sortToast(mode))
}

/**
 * The mine an add just made, until it is on the board (decision log, First run: add a mine: the
 * folder picked becomes the mine and opens in the mine column at once). Main publishes the new mine
 * on its next push, so a mine not on the board yet opens as soon as it arrives; the page scrolls
 * its card into view either way. Adding a mine never opens the Add panel.
 */
const pendingOpen = ref<string | null>(null)
const revealMine = ref<string | null>(null)

function openAdded(mineId: string | undefined): void {
  if (mineId === undefined) return
  revealMine.value = mineId
  if (state.mines.some((mine) => mine.id === mineId)) openFromBrowse(mineId)
  else pendingOpen.value = mineId
}

watch(
  () => state.mines,
  (mines) => {
    const id = pendingOpen.value
    if (id === null || !mines.some((mine) => mine.id === id)) return
    pendingOpen.value = null
    openFromBrowse(id)
  }
)

async function addMine(): Promise<void> {
  openAdded(await addProject())
}

async function adoptMainProject(): Promise<void> {
  openAdded(await openMainProject())
}

/** The Music slot says what it did: "Music on" or "Music off", with that icon (components.md, Nav). */
function toggleMusicAndSay(): void {
  toggleMusic()
  showToast(
    musicPlaying.value ? 'Music on' : 'Music off',
    musicPlaying.value ? 'music-on' : 'music-off'
  )
}
/* --- end of the #635 block ----------------------------------------------- */

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
 * The mine column's width, published to CSS from the same constants main
 * reserves it with (#153, #635): the painting drawn whole at the column's
 * height less its chrome, plus 16px, never under 300px (screens/shell.md,
 * Layout). The column is the shell's height, which is the window's less the
 * dock inset and the plate's padding, so `100vh` less that inset is the
 * height it is derived from. Bound from `INTERIOR_ART_SIZE` and sceneSizing
 * rather than written into the stylesheet, so the column, the window main
 * sized for it and the projection inside it cannot disagree.
 */
const mineColumnWidth =
  `max(${MINE_COLUMN_MIN_WIDTH}px, calc((100vh - ${SHELL_CONTENT_INSET + MINE_COLUMN_CHROME_HEIGHT}px)` +
  ` * ${INTERIOR_ART_SIZE.width} / ${INTERIOR_ART_SIZE.height} + ${MINE_COLUMN_ART_INSET}px))`

/**
 * The shell's own height, which the mine column derives its art from (#635): the window's less
 * the dock inset and the plate's padding, the same inset main reserves the column with.
 */
const shellHeight = `calc(100vh - ${SHELL_CONTENT_INSET}px)`

const loading = ref(true)
const error = ref<string | null>(null)
let unsubscribe: (() => void) | undefined
let unlistenAudio: (() => void) | undefined
/* --- Typography preferences (#370) — one block, appended ------------------- */
let unlistenTypography: (() => void) | undefined
/* --- end of the #370 block ------------------------------------------------- */

/**
 * The dwarf the chat is open on (#159, #162), for the halo on its sprite: at most one in the whole
 * app. Read off the dock, which is the one that learns which dwarf a launch turned out to have
 * started — so the halo is drawn from the same answer the chat is.
 */
const openDwarfId = dock.openDwarfId

/*
 * WHAT CAME BACK WITH THE PANEL (#635): the observed session's feed and everything around it —
 * `selectedFeed`, its token, the pushed-feed signal (#196), the shrink log (#249), both re-read
 * watches (#183, #195), `setWatchedDwarf` — went to MessagePanelWindow.vue for #162 and live in
 * useMessageDock now, which this shell calls once.
 */

/*
 * The board's mine, or else a remembered one nobody is working (PANEL-QUESTIONS 5): it opens like
 * any other card, onto the empty roster and + Dwarf, drawn from its store row (lib/browse/columnMine).
 */
const currentMine = computed<Mine | undefined>(() =>
  viewState.mineId === null ? undefined : columnMine(viewState.mineId, state.mines, projects.value)
)

/*
 * A remembered mine held open has no board push to let it go when it is removed, so a change of the
 * remembered list asks the same question the board push does (useView.syncWithMines).
 *
 * AMENDED for #635 (PANEL-QUESTIONS 25): the question waits until the board AND the remembered list
 * have each been read once. The app now opens on the mine it last closed on, and the board usually
 * answers first: a remembered mine nobody is working is only in the list, so asking on the board
 * alone let it go before the list could say it was still there. Once both are read, a mine that was
 * removed, or whose folder is gone, is let go of as before — it opens nothing, and the page stays.
 */
let boardRead = false
let projectsRead = false
function pruneOpenMine(): void {
  if (!boardRead || !projectsRead) return
  syncWithMines(openableMineIds(state.mines, projects.value))
  settleLaunchMine()
}

/*
 * The mine the launch remembered (#635, PANEL-QUESTIONS 25) is judged here, once, with both lists
 * read: it opens only if it still does, its folder included (launchMineOpens), and it never opens
 * first to close a moment later. One the person has already replaced by opening another mine stays
 * unopened. A mine that no longer opens is forgotten in main at once, so the next launch does not
 * look for it again.
 */
function settleLaunchMine(): void {
  const remembered = takeLaunchMine()
  if (remembered === null) return
  if (viewState.mineId !== null) return
  if (launchMineOpens(remembered, state.mines, projects.value)) openMine(remembered)
  else window.api.setLaunchView({ area: viewState.area, mineId: null })
}
watch(projects, () => {
  projectsRead = true
  pruneOpenMine()
})

/*
 * The page and the mine the next launch opens on (#635, PANEL-QUESTIONS 25): each change is
 * reported to main as it happens, one-way, and main coalesces the writes. The two fields are
 * watched apart so a write-back of an unchanged value reports nothing, and the view the entry
 * restored before mounting is not reported back — only what changes from it.
 */
watch([() => viewState.area, () => viewState.mineId], ([area, mineId]) =>
  window.api.setLaunchView({ area, mineId })
)

/*
 * `toggleSecondary` stood here until #635: the closed rail's arrow, which closed
 * the page and landed on the rail. The rail is gone (PO ruling 2026-09-27):
 * closing the Panel is the app mark's `hidePanel`, and the page is always there.
 * The window's width follows what the Panel shows, in `panelShape` below.
 */

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
  if (viewState.area === 'mines' && browseRefresh.due(snapshot.mines, projects.value)) {
    void refreshProjects()
  }
  for (const cue of attentionWatch.observe(snapshot.mines)) playSfx(cue)
  loading.value = false
  boardRead = true
  pruneOpenMine()
  // A launch in flight is watching for its own dwarf, which arrives on an
  // ordinary poll like every other session's — this is that poll — and the
  // open chat adopts the feed main pushed with it (#196).
  dock.observeSnapshot(snapshot)
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
  // The dock's window slot holds one thing at a time (screens/shell.md,
  // Layout): opening a chat replaces the history in it (#635).
  historyOpen.value = false
  if (openDwarfId.value === dwarf.id) {
    closeMessagePanel()
    return
  }
  // Naming the mine as well as the dwarf: the Add panel that shares the slot
  // needs the mine, and the chat follows its mine rather than the board.
  if (viewState.mineId === null) return
  rememberDockOpener()
  dock.openMessage(viewState.mineId, dwarf.id)
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

/**
 * The mine's History action (#192), and the MessagePanel's (#635): the history opens in the dock's
 * window slot, which holds one thing at a time, so the chat or the Add panel is put away.
 */
function openHistory(): void {
  closeMessagePanel()
  historyOpen.value = true
}

/**
 * What the dock's window slot holds, or `null` when it holds nothing and takes
 * no width (#635, screens/shell.md, Layout: "the window slot none while no
 * chat, Add panel or history is open in it").
 *
 * One thing at a time: the Add panel while a launch is the dock's (through its
 * spawn, until its dwarf is handed over), the chat while it is open on a dwarf,
 * or the history. Keyed so that replacing one with another — a chat for the
 * history, one dwarf's chat for another's — is fresh content in the same slot.
 */
type DockItem = { kind: 'history' | 'launch' | 'message'; key: string }
const dockItem = computed<DockItem | null>(() => {
  const mine = currentMine.value
  if (mine === undefined) return null
  if (dock.launchOpen.value) return { kind: 'launch', key: `launch:${mine.id}` }
  const dwarf = dock.selectedDwarf.value
  if (dwarf !== undefined) return { kind: 'message', key: `message:${dwarf.id}` }
  return historyOpen.value ? { kind: 'history', key: `history:${mine.id}` } : null
})

/*
 * The window is exactly as wide as what the Panel shows (#635, PO ruling
 * 2026-09-27): the nav and the page always, the mine column while a mine is
 * open, the dock's window slot while it holds something. Both are width the
 * WINDOW has to be given before anything can be drawn into it, so each change
 * reshapes it, serialized in usePanelLayout because the two can overlap.
 * Watched as two booleans so switching mines, or history from one mine to the
 * next, asks nothing of the window.
 */
/**
 * The slot's own motion (motion.md, "MessagePanel window (Panel)"): in from its far side, out
 * toward the shell, read against the edge main reports so a left dock mirrors it.
 */
function dockMotion(leaving: boolean): ReturnType<typeof dockWindowMotion> {
  // Leaving with its mine (the mine is already let go of when the leave starts), the window is
  // removed at once, before the column fades (motion.md, "Mine column leaves").
  return dockWindowMotion(leaving, layout.value.edge, { withMine: viewState.mineId === null })
}

watch([() => viewState.mineId !== null, () => dockItem.value !== null], ([mineOpen, dockOpen]) => {
  void applyLayout({ mineOpen, dockOpen })
})

function closeHistory(): void {
  historyOpen.value = false
}

/*
 * What the chat or the launch could not do (#159, #279, #347): the console that could not be
 * brought forward, a path or a link main refused. Said in a toast with the warning icon, where the
 * app says every other refusal (PANEL-QUESTIONS 10), since the anchored panel has no line of its
 * own for it; AMENDED for #635 (was: a notice above the panel in its own window).
 */
watch(dock.error, (text) => {
  if (text !== null) showToast(text, 'warning')
})

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
 * A link in a history message (#635): relayed to main, which validates it again and owns the only
 * `shell.openExternal` in the app, as the MessagePanel's are (#347). A refusal has nowhere to be
 * said in a read-only panel, and the link stays where it was.
 */
async function openHistoryLink(href: string): Promise<void> {
  try {
    await window.api.openExternalLink(href)
  } catch {
    // The bridge is the only way out; nothing else can open it.
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
 * The watch that told the audio the shell had collapsed to its bare rail (#174)
 * stood here until #635. There is no rail to collapse to (PO ruling
 * 2026-09-27); a hidden window still silences everything, through the window's
 * own visibility.
 */

/**
 * The mine's Add action (#86).
 *
 * Re-opening the panel already open on this mine is left alone rather than
 * treated as a toggle: `open()` starts a fresh panel, so a second click would
 * silently discard a prompt somebody was half-way through typing. That guard is
 * useMessageDock's, beside the launch itself. The panel has its own close, and
 * Escape.
 */
function openLaunch(mineId: string): void {
  historyOpen.value = false
  rememberDockOpener()
  dock.openLaunch(mineId)
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
    // Closes whatever the dock has open, the launch included: a launch whose
    // mine went away has nowhere to put the dwarf it is waiting for.
    if (dock.surface.value.surface !== 'none') closeMessagePanel()
  }
)

/*
 * WHAT CAME BACK WITH THE PANEL, PART TWO (#635): `activate` (bringing a
 * session's own console forward), `sendText`, `kickDwarf`, `answerQuestion`
 * and `decidePermission` went to the panel's own window for #162 and are
 * useMessageDock's now, drawn into the dock slot below.
 *
 * REMOVED for #162, stated rather than passing unseen: MineScene's
 * `activatingId` prop, which dimmed a sprite while its console was being
 * raised. The click that starts that is in the other window now, so dimming a
 * sprite here would be feedback in the place nobody is looking; the panel says
 * out loud when the console could not be opened, which is the part that
 * mattered. DwarfSprite's own `activating` prop went with DwarfSprite (#635):
 * nothing fed it, and reviving it would mean publishing the activation the way
 * the delivery verdicts are published.
 */

/* --- System notifications (#316) — one block, appended --------------------- */
/**
 * Which mine INTERIOR is really on screen, reported one-way to main.
 *
 * The rule itself is in `lib/shell/mineOnScreen.ts`, where the two facts it
 * joins — the shell's own navigation and main's report that the column has
 * width — are stated with the reason neither is enough on its own.
 */
const openMineOnScreen = computed(() => mineOnScreen(viewState.mineId, layout.value))
watch(openMineOnScreen, (mineId) => window.api.setOpenMine(mineId), { immediate: true })

/** Released with the window, like every other subscription here. */
let unlistenShowMine: (() => void) | undefined

/**
 * A click on a system notification (#316). Main already showed and raised the
 * window; this is the half only the renderer can do.
 *
 * NO dwarf is selected, exactly as the issue words it — the person clicks the
 * dwarf to open the MessagePanel and read the ask. Closing whatever that window
 * had open is not incidental: the mine may be the one already open, in which
 * case nothing else would clear a selection made before the notification.
 *
 * AMENDED for #635: the layout is left to the shape watch above. It used to be
 * asked for here because the mine watch refused to reopen the window from the
 * bare rail; the rail is gone, and the watch now gives the column its width
 * whatever opened the mine.
 */
function showMineFromNotification(mineId: string): void {
  error.value = null
  if (dock.surface.value.surface !== 'none') closeMessagePanel()
  historyOpen.value = false
  openMine(mineId)
}
/* --- end of the #316 block ------------------------------------------------- */

/* --- Host connection (ISSUE-316) — one block, appended ---------------------- */
// The one Host-state message over the Panel (ADR-002 D9; 07 §12B). useHostConnection is also the one source every
// read model that sends a Host-owned mutation gates on (13 FM-146). The incompatible message's Stop everything and quit
// asks UI main for the tray item's flow over A-N34 (amendment owner-approved 2026-10-01).
const {
  message: hostMessage,
  retrying: hostRetrying,
  start: followHostConnection,
  stop: stopFollowingHostConnection,
  retry: retryHostConnection,
  stopEverything: stopEverythingFromHostMessage
} = useHostConnection()
/* --- end of the ISSUE-316 block --------------------------------------------- */

onMounted(() => {
  // The footprint the first opening unfolds from: whatever rectangle main
  // created the window at, which is the Panel with nothing beside its page.
  settleShellFold(false)
  void load()
  // The map draws every remembered project, not only the live board (#197),
  // and the map is the DEFAULT area — a read gated on visiting Mines first
  // left the common case (open the panel, look at the map) stuck on the
  // board alone. One read at startup, beside the mines poll, is enough:
  // `selectArea` below still re-reads on every Mines visit to stay fresh.
  void loadProjects()
  // Adopts the window's REAL shape: which edge it is docked to decides which
  // way the columns run, and the renderer never chose it.
  void syncLayout()
  // The button's initial "pinned" guess matches main's default; this adopts
  // the real BrowserWindow state (the user may have unpinned on a past run).
  void syncPinned()
  // Reads the accelerator AND whether it actually registered, so a startup
  // failure can be flagged on the Settings button before anyone opens it.
  void syncShortcut()
  void loadBuild()
  // The features that ship hidden (#635): pulled once, like the build.
  void loadFeatureFlags()
  // Adopts the stored Audio settings and the window's REAL visibility, then
  // starts the music if the settings say it should be playing (#174).
  void syncAudio()
  // Hears the window being shown or hidden, and gives the engine its tick.
  unlistenAudio = listenAudio()
  unsubscribe = window.api.onMinesUpdated(update)
  /* --- System notifications (#316) — one block, appended ------------------- */
  // Adopts the stored switch, and listens for a click on a notification main
  // raised. Subscribed rather than pulled, like the message panel above: a
  // click can land at any moment and there is no state to poll for.
  void syncNotifications()
  unlistenShowMine = window.api.onShowMine((mineId) => showMineFromNotification(mineId))
  /* --- end of the #316 block ---------------------------------------------- */
  /* --- Typography preferences (#370) — one block, appended ----------------- */
  // Adopts the stored faces, and listens to main's broadcast of them — which
  // since #635 only ever comes from this window's own Settings, applied twice.
  void syncTypography()
  unlistenTypography = listenTypography()
  /* --- end of the #370 block ----------------------------------------------- */
  /* --- Jev launch routing: the API key setting (#509) — one block, appended - */
  // Adopts the stored verdict. No subscription: unlike typography, nothing
  // outside this window ever changes it — the message panel never draws this
  // section — so there is no push to hear and nothing to release on unmount.
  void syncJevSettings()
  /* --- end of the #509 block ------------------------------------------------ */
  /* --- OpenCode permission relay (#588 T6) — one block, appended ------------ */
  // Adopts the stored verdict, for the reason syncJevSettings gives: nothing
  // outside this window changes it, so there is no push to hear.
  void syncOpenCodeSettings()
  /* --- end of the #588 T6 block --------------------------------------------- */
  /* --- Host connection (ISSUE-316) — one block, appended ---------------------- */
  void followHostConnection()
  /* --- end of the ISSUE-316 block --------------------------------------------- */
})
onBeforeUnmount(() => {
  unsubscribe?.()
  unlistenAudio?.()
  /* --- System notifications (#316) — one block, appended ------------------- */
  unlistenShowMine?.()
  /* --- end of the #316 block ---------------------------------------------- */
  /* --- Typography preferences (#370) — one block, appended ----------------- */
  unlistenTypography?.()
  /* --- end of the #370 block ----------------------------------------------- */
  // Every sound released with the window: a clip left decoding would outlive
  // the surface that asked for it.
  disposeAudio()
  /* --- Host connection (ISSUE-316) — one block, appended ---------------------- */
  stopFollowingHostConnection()
  /* --- end of the ISSUE-316 block --------------------------------------------- */
})

/* --- Stop everything and quit (ISSUE-317) — one block, appended ----------- */
// The confirmation UI main asks for with A-N25, over the current window. App
// owns the composable and therefore the IPC (ADR-033 item 2). Its count is
// the Host read model's owned dwarfs only (OQ-78). The renderer has no Host
// read model of dwarfs yet: in cut 0 the snapshot has no `dwarfs` section
// (ISSUE-026), so it holds none and the count is 0. Later: ISSUE-092 hands in
// the board read model here.
const NO_HOST_DWARFS: readonly StopEverythingDwarf[] = []
const {
  view: stopEverythingView,
  confirm: confirmStopEverything,
  cancel: cancelStopEverything,
  dismiss: dismissStopEverything
} = useStopEverything({ readModel: { dwarfs: () => NO_HOST_DWARFS } })
/* --- end of the ISSUE-317 block ------------------------------------------- */
</script>

<template>
  <!--
    #566 T3: the one `<MotionConfig>` this root hands every popup/modal/
    tooltip surface under it. `boundedMotion.ts`'s own runner
    (`PanelTransition`, `useShellFold`, the message surface) reads
    `sceneMotion` directly and never consults this context — see `reduced`,
    above.
  -->
  <MotionConfig
    :reduced-motion="reduced ? 'always' : 'never'"
    :transition="reduced ? REDUCED_MOTION_TRANSITION : undefined"
  >
    <!--
      The dock (#635, screens/shell.md, Layout): the dock's window slot and the
      shell plate side by side, packed against the screen edge the Panel docks
      to — `row` puts the plate against a right edge and `row-reverse` against a
      left one, so the slot always stands on the plate's outer side. The window
      is exactly as wide as the two, and main sizes it (panelBounds.ts).

      The closed rail that stood on the plate's outer side is gone (PO ruling
      2026-09-27): closing the Panel hides its window, as the app mark does.
    -->
    <div
      class="panel-dock"
      :class="`edge-${layout.edge}`"
      :data-dock="layout.edge"
      @pointerdown.capture="(raisePanel(), notePress($event))"
      @keydown.capture="forgetPress"
    >
      <!--
        The dock's window slot, first in the DOM because the design's tab order
        starts there (screens/shell.md, Left to right: the window, then the nav,
        the page and the open mine). It holds one thing at a time and takes no
        width while it holds nothing: the chat, the Add panel or the mine's
        history (#635), never two of them. Drawn only once main has given the
        window the slot's width (`visibleLayout`), as the mine column is, and
        retained while it leaves so the shrink waits for it. What it holds is
        replaced in place (`dockReplaceMotion`): the old content goes at once
        and the new one fades in, so two panels never share a 440px slot.
      -->
      <PanelTransition :motion="dockMotion" :engine="props.engine" @leave="trackPanelLeave">
        <div v-if="dockItem && visibleLayout.dockOpen" class="dock-window dm-window">
          <PanelTransition :motion="dockReplaceMotion" :engine="props.engine" mode="out-in">
            <AddPanel
              v-if="dockItem.kind === 'launch' && currentMine"
              :key="dockItem.key"
              :mine-name="currentMine.name"
              :chips="dock.launch.chips.value"
              :phase="dock.launch.phase.value"
              :enabled="dock.launch.enabled.value"
              :command="dock.launch.state.value.command"
              :prompt="dock.launch.state.value.prompt"
              :refusal="dock.launch.refusal.value"
              :error="dock.launch.state.value.error"
              :model-picker="dock.launch.modelPicker.value"
              :effort-picker="dock.launch.effortPicker.value"
              :permissions-visible="dock.launch.permissionsVisible.value"
              :jev="dock.launch.jev.value"
              :model="dock.launch.state.value.model"
              :effort="dock.launch.state.value.effort"
              :permission-mode="dock.launch.state.value.permissionMode"
              :failure="dock.launch.state.value.failure"
              @choose="dock.launch.choose"
              @command="dock.launch.setCommand"
              @commit="dock.launch.commit"
              @prompt="dock.launch.setPrompt"
              @model="dock.launch.setModel"
              @effort="dock.launch.setEffort"
              @permission-mode="dock.launch.setPermissionMode"
              @toggle-jev="dock.launch.toggleJevEnabled"
              @toggle-jev-auto="dock.launch.toggleJevAutoAccept"
              @dismiss-jev="dock.launch.dismissJevDecision"
              @submit="dock.launch.submit"
              @retry="dock.launch.retry"
              @pick-manually="dock.launch.pickManually"
              @close="closeDockToOpener"
            />
            <!--
              Keyed by dwarf, so opening the chat on another one is a fresh
              panel. The half-written message is the dock's, per dwarf
              (decision log, Drafts per dwarf), so a switch keeps it.
            -->
            <DwarfMessagePanel
              v-else-if="dockItem.kind === 'message' && dock.selectedDwarf.value"
              :key="dockItem.key"
              :dwarf="dock.selectedDwarf.value"
              :route-gone="dock.selectedRouteGone.value"
              :feed="dock.drawnFeed.value"
              :paging-note="dock.pagingNote.value ?? undefined"
              :draft="dock.drafts.value[dock.selectedDwarf.value.id]"
              :send-state="dock.messageStateFor(dock.selectedDwarf.value.id)"
              :echoes="dock.sentEchoes[dock.selectedDwarf.value.id]"
              :echo-attachments="dock.sentEchoAttachments[dock.selectedDwarf.value.id]"
              :kick-state="dock.kickingState.byDwarfId[dock.selectedDwarf.value.id]"
              :answer-state="dock.questionState.byDwarfId[dock.selectedDwarf.value.id]"
              focus-on-open
              @draft="dock.setDraft(dock.selectedDwarf.value.id, $event)"
              @send="dock.sendText(dock.selectedDwarf.value, $event)"
              @retry="dock.retryMessage(dock.selectedDwarf.value, $event)"
              @copy="dock.copyMessage"
              @kick="dock.kickDwarf(dock.selectedDwarf.value)"
              @answer="dock.answerQuestion(dock.selectedDwarf.value, $event)"
              @answer-text="dock.answerQuestionInWords(dock.selectedDwarf.value, $event)"
              @decide="dock.decidePermission(dock.selectedDwarf.value, $event)"
              @open-console="dock.activate(dock.selectedDwarf.value)"
              @open-path="dock.openPath"
              @open-link="dock.openLink"
              @page-back="dock.pageBack"
              @history="openHistory"
              @close="closeDockToOpener"
            />
            <HistoryPanel
              v-else-if="dockItem.kind === 'history' && currentMine"
              :key="dockItem.key"
              :mine="currentMine"
              :history="mineHistory"
              :path-refusal="historyPathRefusal"
              :failed="dwarfDelivery.failed"
              @close="closeHistory"
              @open-path="openHistoryPath"
              @open-link="openHistoryLink"
            />
          </PanelTransition>
        </div>
      </PanelTransition>

      <div
        ref="shellEl"
        class="shell m-mat"
        :class="`edge-${layout.edge}`"
        :data-dock="layout.edge"
        :style="{ '--mine-column-width': mineColumnWidth, '--shell-h': shellHeight }"
      >
        <!--
        The nav, at the screen edge (#635), and first of the columns in the DOM (PANEL-QUESTIONS 2,
        design lead ruling 2026-09-27): tab order is the DOM order, and it is the nav, then the
        page, then the open mine on both docks (accessibility.md, Keyboard). CSS `order` below
        keeps it the last column of the row, which `row` puts against a right edge and
        `row-reverse` against a left one, so nothing moves on screen for it.
        Its app mark hides the WINDOW (#156), which is the same hidePanel the
        global shortcut and Settings' own hide control already ask for. The
        layout is deliberately untouched: the panel that comes back is the one
        that went away, mine and page and all.

        The mode lever is left out until a mode beyond the Panel exists: Veta
        and Valle are later slices, and the docs say nothing of a lever whose
        destination is not built yet, so the nav's own "no dead buttons" rule
        is the fallback until that is ruled on.

        AMENDED for #635: the nav and the page are always there while the
        window shows ("the page and the nav are always there"), so neither is
        mounted or retained by the fold any more; only the mine column is.
      -->
        <PanelNav
          ref="navEl"
          :page="page"
          :guild="featureFlags.guildAreasEnabled"
          :badge="needsYou"
          :music="musicPlaying"
          :warn="shortcutBroken"
          :lever="false"
          @nav="selectArea"
          @mark="hidePanel"
          @music="toggleMusicAndSay"
        />

        <!--
      The page. The area switch inside it animates itself: it moves within
      bounds nothing is resizing.
    -->
        <div ref="secondaryEl" class="shell-secondary">
          <PanelTransition :engine="props.engine" @leave="trackPanelLeave">
            <!--
          The Map page (#635) in the page column, where the Mines page stands: the redesign
          replaced the 21px map frame, so the painting is no longer letterboxed inside it.
          Until the first board arrives it claims no empty valley (`loading`).
        -->
            <MapPage
              v-if="page === 'map'"
              class="shell-page"
              :mines="state.mines"
              :projects="projects"
              :materials="state.materials"
              :open-id="viewState.mineId"
              :variant="mapVariant"
              :adding="addingProject"
              :loading="loading"
              @open="enterMine"
              @refuse="refuseMine"
              @add="addMine"
            />

            <MinesList
              v-else-if="page === 'mines'"
              class="shell-page"
              :cards="mineCards"
              :open-id="viewState.mineId"
              :search="browseFilters.search"
              :tier="browseFilters.tier"
              :sort="browseFilters.sort"
              :loading="browseLoading"
              :error="browseError"
              :adding="addingProject"
              :add-error="addProjectError"
              :removing="removingMine"
              :remove-error="removeMineError"
              :worktree-question="worktreeQuestion"
              :reveal-id="revealMine"
              :engine="props.engine"
              @search="setProjectSearch"
              @tier="setProjectTier"
              @sort="sortProjects"
              @add="addMine"
              @open="openFromBrowse"
              @refuse="refuseMine"
              @remove="removeFromBrowse"
              @open-main-project="adoptMainProject"
              @dismiss-worktree="dismissWorktreeQuestion"
            />

            <!--
          Settings (#138, #635): the redesigned page, standing on the shell's plate
          like every other page — its header, the seven section tabs and the
          chosen section's rows.
        -->
            <SettingsPanel
              v-else-if="page === 'settings'"
              class="shell-page"
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
              :notifications-enabled="notificationsEnabled"
              :typography="typography"
              :typography-applying="typographyApplying"
              :jev-settings="jevSettings"
              :jev-saving="jevSaving"
              :jev-providers="jevProviders"
              :jev-catalogs="jevCatalogs"
              :open-code-settings="openCodeSettings"
              :open-code-applying="openCodeApplying"
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
              @notifications-change="setNotificationsEnabled"
              @typography-change="setTypography"
              @jev-save="saveJevApiKey"
              @jev-clear="clearJevApiKey"
              @jev-preferences-change="setJevPreferences"
              @opencode-plugin-change="setOpenCodePluginEnabled"
              @opencode-password-save="saveOpenCodeServerPassword"
              @opencode-password-clear="clearOpenCodeServerPassword"
            />

            <!--
            The Lab, the Market and the Laboral Union (#335, #635): the guild
            page, reached only once the guild flag reveals them (`page` never
            names one otherwise), keyed so switching between them re-enters the
            transition rather than swapping the painting under a still page.
            `v-else-if` rather than `v-else`, because an area with no screen
            and no guild page should draw nothing instead of borrowing another
            hall's sentence. It stands on the plate itself, with no frame of
            its own, as the design draws it.
          -->
            <GuildPage
              v-else-if="unavailableArea"
              :key="page"
              class="shell-page"
              :area="unavailableArea"
            />
          </PanelTransition>

          <p v-if="error" class="notice" role="alert">{{ error }}</p>
          <!--
            Toasts stand in the page column, centred 56px from its bottom, whatever raised them
            (PANEL-QUESTIONS 10, PO ruling 2026-09-27): never over the painting, the dwarfs or the
            MessagePanel's composer. The column is the containing block.
          -->
          <ToastHost />
          <!-- ISSUE-316: the one Host-state message, over the Panel's page column (ADR-002 D9). -->
          <HostStateMessage
            :message="hostMessage"
            :retrying="hostRetrying"
            :on-stop-everything="stopEverythingFromHostMessage"
            @retry="retryHostConnection"
          />
        </div>

        <!--
        One mine beside AT MOST one secondary panel: the concurrent model the
        design's exports prove, and no more than that — the source warns in as
        many words against assuming arbitrary multi-panel stacking. The column
        follows the view's own open mine, as it always has; what main's
        `mineOpen` decides is whether this whole block is drawn, because it is
        width the window has to be given first (#153). The column hands its
        motion to the ground it stands on (#388): `hold` is the shell's own
        fold, and the column is only RETAINED here until it ends — unmounting it
        before main has shrunk the window would repack the row inside a
        rectangle that has not changed yet.
      -->
        <PanelTransition
          :hold="holdColumn"
          :hold-enter="enterColumn"
          :engine="props.engine"
          @leave="trackPanelLeave"
        >
          <div v-if="visibleLayout.mineOpen && currentMine" class="shell-mine">
            <!--
            The redesigned mine column (#635), on the plate itself as the design
            draws it. Keyed by the mine, so switching from one to another is a
            fresh column rather than the same one handed different dwarfs (#153):
            a dwarf already there when a column opens is drawn settled in its
            state, and only a later arrival fades in.
          -->
            <MineColumn
              :key="currentMine.id"
              :mine="currentMine"
              :arrived="state.arrived"
              :send-states="dwarfDelivery.send"
              :kick-states="dwarfDelivery.kick"
              :selected-id="openDwarfId"
              :ambience-muted="ambienceMuted"
              @close="leaveMine"
              @select="selectDwarf"
              @add="openLaunch(currentMine.id)"
              @history="openHistory"
              @toggle-ambience-mute="toggleAmbienceMute"
              @crew-sound="playCrew"
            />
          </div>
        </PanelTransition>
      </div>
    </div>
    <!--
      Stop everything and quit (ISSUE-317): the confirmation over the whole
      window, drawn into <body> by the dialog itself, so nothing here clips it.
    -->
    <StopEverythingConfirmation
      :view="stopEverythingView"
      @confirm="confirmStopEverything"
      @cancel="cancelStopEverything"
      @dismiss="dismissStopEverything"
    />
  </MotionConfig>
</template>

<style scoped>
/*
 * The dock (#635, screens/shell.md, Layout and Parts): the dock's window slot
 * and the shell plate in one row, packed against the screen edge the Panel
 * docks to. A left-docked Panel is the same DOM in the other direction, which
 * is what `row-reverse` buys — one order to reason about, mirrored once — and
 * `flex-end` is the right of a `row` and the left of a `row-reverse`, the
 * docked side each time.
 *
 * The window is exactly as wide as what the row shows (PO ruling 2026-09-27);
 * main reserves every number below and nothing else (panelBounds.ts, which
 * pins these custom properties to its own constants). Packed against the
 * docked edge, a frame in which the window and the row briefly disagree leaves
 * its slack on the FREE side, which is the band main is adding or taking and
 * is transparent either way (#488). What still does not fit on a screen
 * narrower than the dock runs off the far side, away from the docked edge
 * (decision log, Narrow screen).
 */
.panel-dock {
  --shell-edge: 2px;
  --dock-inset: 12px;
  --dock-gap: 12px;
  --dock-width: 440px;
  --dock-free-room: 6px;
  display: flex;
  justify-content: flex-end;
  height: 100vh;
  overflow: hidden;
  color: var(--color-cream);
  font-size: var(--text-meta);
}
.panel-dock.edge-left {
  flex-direction: row-reverse;
}
/*
 * The dock's window slot (`.dm-window`): as tall as the shell, as wide as what
 * it holds, and never shrunk. The dock's 12px gap is measured from the plate's
 * box, which already stands 2px off the slot on its own margin, so the slot
 * takes the rest; on its outer side it keeps the room its content's raised
 * material draws beyond its box (`.m-mat` edge, `.m-raised` shadow), which main
 * reserves as DOCK_FREE_ROOM.
 */
.dock-window {
  display: flex;
  flex: none;
  width: var(--dock-width);
  height: calc(100vh - 2 * var(--dock-inset));
  min-height: 0;
  margin: var(--dock-inset) calc(var(--dock-gap) - var(--shell-edge)) var(--dock-inset)
    var(--dock-free-room);
}
.panel-dock.edge-left .dock-window {
  margin-right: var(--dock-free-room);
  margin-left: calc(var(--dock-gap) - var(--shell-edge));
}
/* The history fills the slot (`.dm-hist`: width 440px, height 100%). */
.dock-window > .dm-hist {
  height: 100%;
}
/*
 * The redesigned Panel's plate (#635, screens/shell.md, Layout and Parts): one
 * rock plate with a brass-lo edge, 6px padding and 6px gaps, inside the dock's
 * 12px inset from the top and the bottom of the work area, held 2px off the
 * screen edge so that edge shows. The window still spans the work area; the
 * inset is drawn here, so no platform's window geometry changes for it.
 *
 * The 2px on the FREE side is not in the design's margin: the plate's material
 * draws its edge 2px outside its box on every side (`.m-mat`), and main
 * reserves that room in the window so the free edge is painted rather than cut
 * off by it (SHELL_EDGE_MARGIN in main/shell/panelBounds.ts). With the dock
 * slot open that room is part of the dock's 12px gap.
 *
 * Its ground is also the surface the mine column's motion is drawn on (#388):
 * `clip-path` is set on this element, from useShellFold, and folds it toward
 * the docked edge so main only ever resizes the window into pixels that are
 * already transparent. Nothing here declares it — a clip left in the
 * stylesheet would be a second opinion about how wide the shell is — but every
 * rule below is inside it.
 *
 * The padding is load-bearing rather than decoration: main reserves it in the
 * window, and the mine column's width is derived from the height it leaves.
 *
 * It is as wide as its columns (`flex: 0 1 auto`) rather than as the window,
 * so the dock slot beside it never reads to the fold as the plate growing, and
 * on a screen narrower than the dock its page column is the part that gives
 * way (the nav and the mine column never shrink).
 */
.shell {
  --shell-pad: 6px;
  --shell-gap: 6px;
  --page-width: 440px;
  --mat-fill: var(--rock);
  --mat-hi: var(--rock-hi);
  --mat-lo: var(--rock-lo);
  --mat-edge: var(--brass-lo);
  position: relative;
  display: flex;
  flex: 0 1 auto;
  /* May shrink below its columns on a screen narrower than the dock, so the page gives way. */
  min-width: 0;
  justify-content: flex-end;
  height: calc(100vh - 2 * var(--dock-inset));
  margin: var(--dock-inset) var(--shell-edge);
  gap: var(--shell-gap);
  padding: var(--shell-pad);
  overflow: hidden;
}
.shell.edge-left {
  --panel-motion-x: -12px;
  flex-direction: row-reverse;
}
/*
 * Where each column stands, which is no longer where it is in the DOM (PANEL-QUESTIONS 2, design
 * lead ruling 2026-09-27). The nav comes first of the columns in the DOM so Tab walks the nav, then
 * the page, then the open mine on both docks (accessibility.md, Keyboard); `order` keeps it at the
 * screen edge, so a `row` still runs page, mine, nav from the free edge and `row-reverse`
 * mirrors it.
 */
.shell > .shell-secondary {
  order: 1;
}
.shell > .shell-mine {
  order: 2;
}
.shell > .dm-nav {
  order: 3;
}
/*
 * The page column (#635): 440px, and on a screen narrower than the dock it is
 * the part that gives way (decision log, Narrow screen). The column shrinks and
 * clips, and the page inside keeps its 440px anchored against the mine column
 * — the docked side — so it is cut at its far side, exactly as the prototype's
 * `minmax(0, 440px)` column does. The nav and the mine column never shrink.
 */
.shell-secondary {
  position: relative;
  display: flex;
  flex: 0 1 var(--page-width);
  flex-direction: column;
  /*
   * A width of its own as well as the basis (#635, live check): the plate is sized to its
   * columns, and a flex basis is not counted when a container is sized to its content. The
   * page's own content is absolute, so without this the plate drew the column 0px wide.
   */
  width: var(--page-width);
  min-width: 0;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}
.shell-secondary > * {
  flex: 1;
  min-height: 0;
}
.shell-secondary > .shell-page {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: var(--page-width);
}
.shell.edge-left .shell-secondary > .shell-page {
  right: auto;
  left: 0;
}
/*
 * The mine's own column, between the page and the nav (#635): the nav anchors
 * to the screen edge and the mine opens inward beside it, so opening or closing
 * a mine never moves the nav (screens/shell.md, W1).
 *
 * Its width is DERIVED, not declared (#153, #635): the painting drawn whole at
 * the column's height less its chrome, plus 16px, never under 300px — the
 * `--mine-column-width` the script binds. main reserves the same number in the
 * window; see mineColumnWidth in main/shell/panelBounds.ts and
 * interiorColumnWidth in lib/scene/sceneSizing. The mine column inside
 * declares the same width from the same constants and `--shell-h`.
 */
.shell-mine {
  position: relative;
  display: flex;
  flex: none;
  flex-direction: column;
  width: var(--mine-column-width);
  height: 100%;
  min-width: 0;
}
.shell-mine > .dm-minecol {
  flex: 1;
  min-height: 0;
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
  color: var(--danger-hi);
  background: var(--danger-bg);
}
</style>
