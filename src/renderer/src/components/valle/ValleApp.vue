<script setup lang="ts">
/*
 * The Valle window's root (ADR-025 item 1; 07 machine 39; ISSUE-299): its own renderer of the same bundle, mounted for
 * `?mode=valle` once its stores were read (S39.03, `main.ts`), so its first paint is the stored layout. The window
 * around it lies on the work area of the display it was entered from (UI main, `ValleWindowController`).
 *
 * - The stores (`useValleStores`): the persisted preset, layouts, mosaic order, pins, last Work front mine and muted
 *   mines, and the session's Valle fields; read again after Reset metrics (S39.10).
 * - The preset (`useVallePreset`, 07 machine 28; ISSUE-300): the top bar's preset tabs and arrow keys, Esc (a nav page
 *   first, then the Work front's climb out), the Work front's folded list, a nav page over the main zone, a resize, and
 *   "▼ Panel" / "▼ Veta" carrying the chat in focus. Every change is written at once (A-N21). The top bar, the nav and
 *   the chat zone never move. The zones' contents and the pins' own chats arrive with their issues (ISSUE-301…ISSUE-310;
 *   hidden until built, 21 §1 item 8).
 * - The splitter (`useValleSplitter`, 07 machine 33; ISSUE-305): the chat zone's width per preset, dragged, keyed or
 *   reset, each commit written at once with both layouts (A-N21). Its range reads the body's width from the split's one
 *   observer, the Work front's list, the split shown and the mine's roster, so it re-clamps as they change, never on a
 *   timer; a reset jumps the width and FLIPs the chat zone and the splitter into place.
 * - The pinned chats (`useVallePins`, 07 machines 18, 29; ISSUE-302): restored once the Host's facts are read (S29.02),
 *   or the start-up pins on a first visit (S29.01); drawn as the Control room's stack (`PinnedStack`) or the Work
 *   front's tabs (`ChatDeck`) in the one chat zone, which never moves. Every change is written at once (A-N21 `pins`,
 *   A-N18 for the session's fields); the chat in focus is the one "▼ Panel" / "▼ Veta" carry. The chats themselves
 *   (the MessagePanel and the Add panel inside a pin) are hosted in the stack's and the deck's `chat` slot, fed by the
 *   window's one message dock (`useValleChats`; a package gap resolved in development, EPIC-20 task TVC).
 * - The split (`useValleSplit`, 07 machine 30; ISSUE-303): "⫽" in the Work front's deck shows two chats side by side,
 *   never three; the room beside the mine is measured by one `ResizeObserver` on the body (never polled), and below
 *   640 px the split steps back to the focused pane and comes back by itself. The wish is written with the Work front
 *   layout (A-N21), the second pane's chat goes to the session (A-N18).
 * - The dive into a mine and the climb out (07 machine 28; ISSUE-301): `⤢` on a column, a double-click on its art, or
 *   the Work front tab dives; "Control room" or Esc climbs out; a row of the Work front's list swaps the mine in place.
 *   The stage (`flip.ts`) plays each run by FLIP over the frozen copies in `.dm-vghosts`, through the bounded runner;
 *   while a dive or a climb runs, every press and key inside Valle is dropped but a mode control, which machine 28
 *   holds (the input gate). The dive rebuilds the tab order through the pins (S29.12) and the split (S30.07). A window
 *   going hidden resolves the run at once (S28.22); the Host removing the mine shown swaps or climbs out (S28.23).
 * - The mosaic and the zones (`useValleMosaic`, 07 machines 31, 32; ISSUE-304): opened once the Host's facts are read
 *   (S32.01, S32.02); each zone's "⋯" opens its menu (what it shows, "Dive in · Work front", the ambience, "Close this
 *   column"), the dashed slot after the last column adds a mine, or a new project through the ordinary folder flow. Every
 *   change is written at once (A-N21); Esc closes an open menu first (NFR-A11Y-02). A closed column's toast goes through
 *   the window's one toast queue (BR-23); nothing reaches the Host for it.
 * - The pages a zone or a nav page shows (ISSUE-304; 07 S31.03…S31.05, S28.19): the Panel's own Map, Mines list and a
 *   mine's history, fed by the composables the Panel's shell uses (`useMines`, `useMapPage`, `useMinesPage`,
 *   `useMineHistoryPage`) and provided to them as `VALLE_PAGES`. The board's own arrival toast stays off here
 *   (`announce: false`): Valle says an arrival once, through `useValleArrivalToast`. A mine opened from a hosted Map
 *   or Mines list leaves a nav page (S28.20), then joins the mosaic and is scrolled to (S32.14) or swaps into the Work
 *   front (S28.15). Settings is the Panel's own page without the Panel-window rows, its Sound rows changing the stored
 *   settings alone (`ValleSettingsPage`; owner decision 2026-10-22).
 * - The read models (`createValleReadModel`): the Host's mines and dwarfs, held as last known while the Host is
 *   unreachable (`data-held`, S34.12), a re-snapshot applied without motion.
 * - On screen (`useVallePresence`, S39.04, S39.05): each zone registers itself through `track` (provided as
 *   `VALLE_TRACK_ZONE`); only zones showing their mine and at least half inside the viewport are reported, nothing while
 *   hidden or while a nav page covers the main zone.
 * - The "started in" toast (`useValleArrivalToast`, S39.11) through the window's one toast queue (BR-23).
 * - The current mine and the sound (`useCurrentMine`, 07 machine 35; ISSUE-307): one current mine for the Valle host,
 *   made current by a chat focused in a pin (S35.01), a single click on a zone's painting or header (S35.02), or a
 *   dive, swap or list pick (S35.03), else the fallback (S35.06), written through A-N18 and marked by the brackets.
 *   The window's one sound engine (`useAudio`, owner decision 2026-10-22 lifted by US-VALLE-016) plays only that
 *   mine's room tone, bed and crew, silenced by its own mute; the attention cues (`useAttentionCues`) and a dwarf's
 *   voice are never gated on it. It follows the page's own visibility (a hidden window plays nothing, S35.08), plays
 *   no music and no Panel cue, and adopts the stored Sound settings again on every show and when Valle's Settings page
 *   closes (the page's rows write the preference alone).
 * - The history drawer (`useValleHistoryDrawer`, 07 machine 36; ISSUE-308): "Mine history" in the Work front's mine
 *   toolbar, the deck's History bar, or a chat's mine-history request in the deck opens the mine's history under the
 *   chat tabs and panes, rising with a fade, the chats above never moved; its own close sinks it with a fade. A climb
 *   out, leaving Valle or a hidden window closes it at once, a swap keeps it on the new mine, its mine removed closes
 *   it. The same request from a chat in the Control room stack shows the history in that mine's zone instead (S31.11).
 * - Reset preset (`useValleResetPreset`, 07 machine 37; ISSUE-309): the top bar's "⋯" holds "Reset preset", not offered
 *   during a dive or a climb. It puts the preset shown back to its defaults alone: both layouts written through the
 *   preset's one writer with the other preset copied, the splitter at rest (S33.10), the Control room's mosaic
 *   recomputed (S32.15) or the Work front's split turned off (S30.11), the zones' content FLIPping to the default layout
 *   and the toast through the window's one queue (BR-23). Pins are never touched. Esc closes its menu first (NFR-A11Y-02).
 * - The needs-you counter and queue (`useValleNeedsYou`, 07 machine 34; ISSUE-306): the top bar's "Need you ▸" and the
 *   footer's row, read from the Host's queue the read model holds and patched in place by its frames. A press jumps in the
 *   preset shown, never changing it: in the Control room the mine's column added and scrolled to (S32.14), the dwarf's
 *   chat pinned and expanded (S29.19), its mine current (S35.01) and its zone's ring called; in the Work front a swap to
 *   its mine (S28.15), then its tab. The footer is the window's third row and never moves.
 * - The mode lever's part (07 machine 9, S28.21, S29.23; ISSUE-311): a chat carried in by a mode run is pinned and
 *   focused once the Host's facts are read, and the run restores its draft and view into it; the chat in focus alone
 *   registers its hand-off (`inFocus`), so "▼ Panel" / "▼ Veta" carry its draft and scroll.
 * - The reveal of a notification click (`useValleReveal`, A-N16; 07 S39.06, S39.07; ADR-025 item 8; ISSUE-311): in the
 *   preset shown, never changing it or the mode; a page gives way, the column is added and scrolled into view (the
 *   scroll saved for the session), the chat pinned and focused, the mine made current; in the Work front a swap and the
 *   tab. Every scroll to a zone is the reveal's: smooth, a jump under reduced motion.
 * - Reduced motion (US-SHELL-011.AC05, AC06; NFR-A11Y-10): read once as the window renders; the counter's "?" stops
 *   bobbing, a called zone's ring is not drawn, a scroll to a zone jumps.
 *
 * The bridge is the composition root's (`valleBridgeOf(window.api)`, R13); the observer is the browser's own unless a
 * test hands one.
 */
import type { DwarfId, MineId, MoveToModeParams } from '@dwarfai/contracts'
import { computed, nextTick, onMounted, onUnmounted, provide, shallowRef, watch } from 'vue'
import { useAttentionCues } from '../../composables/useAttentionCues'
import { useAudio, type AudioVisibility } from '../../composables/useAudio'
import { useCurrentMine } from '../../composables/useCurrentMine'
import { useValleArrivalToast } from '../../composables/useValleArrivalToast'
import { VALLE_ART_CLOCKS, useValleArtClocks } from '../../composables/useValleArtClocks'
import { useValleChats } from '../../composables/useValleChats'
import { useValleHistoryDrawer } from '../../composables/useValleHistoryDrawer'
import { useValleMosaic, type ValleZoneKey } from '../../composables/useValleMosaic'
import { useValleNeedsYou } from '../../composables/useValleNeedsYou'
import { useMapPage } from '../../composables/useMapPage'
import { useMines } from '../../composables/useMines'
import { modeTransitionPart, type CarriedChat } from '../../composables/useModeTransition'
import { useMinesPage } from '../../composables/useMinesPage'
import { useVallePins } from '../../composables/useVallePins'
import { useVallePreset } from '../../composables/useVallePreset'
import { useVallePresence, type VallePresenceDeps } from '../../composables/useVallePresence'
import {
  browserBodyObserver,
  useValleSplit,
  type ValleBodyObserver
} from '../../composables/useValleSplit'
import { useValleResetPreset } from '../../composables/useValleResetPreset'
import { useValleReveal } from '../../composables/useValleReveal'
import { useValleSplitter } from '../../composables/useValleSplitter'
import { useValleStores, type ValleStores } from '../../composables/useValleStores'
import { useToasts } from '../../composables/useToasts'
import { SYSTEM_SLOTS, WORLD_SLOTS, type PanelNavSlot } from '../../lib/shell/panelNav'
import {
  BROWSER_CLOCK,
  createInputGate,
  createValleStage,
  type ValleClock
} from '../../lib/valle/flip'
import type { AudioPlayer } from '../../lib/audio/player'
import type { CrewSoundEvent } from '../../lib/audio/crew'
import { mineCrew } from '../../lib/scene/mineColumn'
import { sceneDwarfStatus } from '../../lib/scene/sceneDwarf'
import { mineRowCrew } from '../../lib/valle/mineRows'
import { mapTotals } from '../../lib/map/mapPage'
import type { PausableFrameClock } from '../../lib/sprite/frameClock'
import type { Dwarf, Mine } from '../../types'
import type { PinKey } from '../../lib/valle/pins'
import type { ValleFacts, ValleNavPage } from '../../lib/valle/preset'
import { createVetaMotion } from '../../lib/veta/vetaMotion'
import { createValleReadModel } from '../../lib/valle/valleReadModel'
import WorktreeDialog from '../browse/WorktreeDialog.vue'
import CrewRoster from '../scene/CrewRoster.vue'
import DwarfPortrait from '../dwarf/DwarfPortrait.vue'
import VaultStrip from '../vault/VaultStrip.vue'
import ToastHost from '../overlay/ToastHost.vue'
import ChatDeck from './ChatDeck.vue'
import NeedsYouCounter from './NeedsYouCounter.vue'
import NeedsYouQueue from './NeedsYouQueue.vue'
import HistoryDrawer from './HistoryDrawer.vue'
import ValleChat from './ValleChat.vue'
import NavSlot from '../shell/NavSlot.vue'
import ValleControlRoom from './ValleControlRoom.vue'
import ValleNavPageView from './ValleNavPage.vue'
import PinnedStack from './PinnedStack.vue'
import ValleTopBar from './ValleTopBar.vue'
import ValleHostedPage from './ValleHostedPage.vue'
import ValleSettingsPage from './ValleSettingsPage.vue'
import ValleSplitter from './ValleSplitter.vue'
import ValleZoneHistory from './ValleZoneHistory.vue'
import ValleWorkFront from './ValleWorkFront.vue'
import ValleMineArt from './ValleMineArt.vue'
import { VALLE_PAGES, VALLE_TRACK_ZONE } from './valleZones'
import type { ValleBridge } from './valleEntry'

const props = defineProps<{
  bridge: ValleBridge
  stores: ValleStores
  observer?: VallePresenceDeps['observer']
  /** The body's width observer; the browser's `ResizeObserver` unless a test hands one. */
  bodyObserver?: ValleBodyObserver
  /** The clock a dive or a climb runs on; the browser's frames and timers unless a test hands one. */
  clock?: ValleClock
  /** The sound engine's player; one `Audio` element per clip unless a test hands one. */
  audioPlayer?: AudioPlayer
  /** A new frame clock for one zone's art; the window's own frames unless a test hands one. */
  artClock?: () => PausableFrameClock
}>()

const { stores } = useValleStores(props.bridge, props.stores)
const model = createValleReadModel(props.bridge)

// The pages a zone or a nav page shows: the window's own board and the Panel's page parts (ISSUE-304).
const board = useMines()
const mapPage = useMapPage()
const minesPage = useMinesPage({
  open: (mineId) => openMine(mineId as MineId),
  mines: () => board.state.mines
})
provide(VALLE_PAGES, {
  board: board.state,
  map: mapPage,
  mines: minesPage,
  failed: () => chats.failed.value
})
watch(
  () => board.state.mines,
  () => mapPage.loaded()
)

/**
 * A mine opened from a hosted Map or Mines list (a package gap resolved in development, ISSUE-304): a nav page over the
 * main zone returns to the preset beneath first (S28.20); then the Control room adds its column and scrolls to it
 * (S32.14), the Work front swaps it in (S28.15).
 */
function openMine(mineId: MineId): void {
  if (view.value.page !== null) preset.send({ kind: 'escape', layerOpen: false })
  mosaic.reveal(mineId)
}

/** The Valle root: the stage the dive's frozen copies are placed over, and where the input gate listens. */
const rootEl = shallowRef<HTMLElement | null>(null)
const room = shallowRef<{ mosaic: HTMLElement | null } | null>(null)
const reduced = (): boolean =>
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches
/** The reduced-motion stand-ins (US-SHELL-011.AC05; NFR-A11Y-10): read once, as the window renders. */
const still = reduced()
// The bounded runner plays each part (`DS/docs/motion.md`, Rules: never `animation.finished` alone).
const parts = createVetaMotion()
const stage = createValleStage({
  root: () => rootEl.value,
  box: (element) => element.getBoundingClientRect(),
  animate: (element, frames, timing) => {
    void parts.run(element, frames, timing)
  },
  cancel: () => parts.cancel(),
  afterRender: (run) => {
    void nextTick(run)
  },
  reduced,
  scroll: (element, left) => {
    element.scrollLeft = left
  }
})

const enterable = (mineId: MineId): boolean =>
  model.mines.value.some((mine) => mine.id === mineId && mine.state !== 'unenterable')

/** What machine 28 reads: the mines, the mosaic, the last mine worked in, the scroll, the chat in focus. */
function presetFacts(): ValleFacts {
  const mines = model.mines.value
  // First visit: the most recent mine (S28.06).
  const recent = [...mines].sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0]?.id ?? null
  return {
    mines: mines.map((mine) => ({ mineId: mine.id, enterable: mine.state !== 'unenterable' })),
    mosaic: columns.value.map((column) => column.mineId),
    lastMine: stores.value.lastFrontMineId ?? recent,
    scrollLeft: room.value?.mosaic?.scrollLeft ?? 0,
    focus: pins.focused.value
  }
}

const preset = useVallePreset({
  bridge: props.bridge,
  stores,
  facts: presetFacts,
  // S29.12 through the pins, S30.07 through the split.
  dived: (mineId, forDwarfId) => {
    split.sendPin(pins.diveInput(mineId, forDwarfId))
  },
  motion: { clock: props.clock ?? BROWSER_CLOCK, reduced, stage }
})
const view = preset.view
/** A dive or a climb is running: input waits (S28.09, S28.14). */
const gated = (): boolean =>
  view.value.motion?.kind === 'diving' || view.value.motion?.kind === 'climbing'

/** Whether Valle is the shown mode window: a hidden window's page is hidden (ADR-025 item 7). */
const shown = shallowRef(document.visibilityState === 'visible')
const visibilityChanged = (): void => {
  shown.value = document.visibilityState === 'visible'
  // A reveal heard while hidden plays once the window is shown again (S10.11).
  if (shown.value) valleReveal.shownChanged()
  // A hidden window freezes timelines: the run resolves at once (S28.22); the history drawer closes at once (S36.04).
  if (!shown.value) historyDrawer.send({ kind: 'hidden' })
  if (!shown.value) preset.send({ kind: 'hidden' })
  // S35.08: the current mine is kept for the next show, where the stored Sound settings are adopted again.
  if (!shown.value) currentMine.send({ kind: 'hidden' })
  else void audio.sync()
}
document.addEventListener('visibilitychange', visibilityChanged)

/** The Valle page's own visibility, the sound engine's gate (S35.08): the Panel's A-P1 push says nothing of Valle. */
const pageVisibility: AudioVisibility = {
  read: () => Promise.resolve(document.visibilityState === 'visible'),
  listen: (listener) => {
    const heard = (): void => listener(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', heard)
    return () => document.removeEventListener('visibilitychange', heard)
  }
}
/** The window's one sound engine (US-VALLE-016): no music and no Panel cue here. */
const audio = useAudio({
  player: props.audioPlayer,
  visibility: pageVisibility,
  music: false,
  panelCue: false
})
let stopCues: (() => void) | undefined
let stopAudio: (() => void) | undefined
let unmounted = false

/** The window's observers over the Valle viewport: the on-screen report's and the zones' art clocks'. */
const viewportObserver: VallePresenceDeps['observer'] =
  props.observer ??
  ((callback, options) =>
    new IntersectionObserver(
      (entries) =>
        callback(entries.map(({ target, intersectionRatio }) => ({ target, intersectionRatio }))),
      options
    ))
const presence = useVallePresence({
  bridge: props.bridge,
  // A nav page over the main zone hides every mine (S39.05; 07 §24 I-36).
  facts: () => ({ shown: shown.value, pageOverMain: view.value.page !== null }),
  observer: viewportObserver
})
provide(VALLE_TRACK_ZONE, presence.track)
// Each zone's sprites on a clock of their own, held still while the zone is out of view (NFR-PERF-10).
provide(
  VALLE_ART_CLOCKS,
  useValleArtClocks({
    observer: viewportObserver,
    ...(props.artClock ? { clock: props.artClock } : {})
  })
)

const { showToast } = useToasts()
useValleArrivalToast({
  facts: model,
  onScreen: () => presence.onScreen(),
  shown: () => shown.value,
  showToast: (text) => showToast(text)
})
const held = computed(() => String(model.held.value))

/** Whether the Host's facts were read once: the pins and the mosaic order restore against them (S29.02, S32.02). */
const factsRead = shallowRef(false)
/** Settles once the first read of the Host's facts did, read or not. */
let settleFacts: () => void = () => {}
const factsSettled = new Promise<void>((resolve) => {
  settleFacts = resolve
})
/** S35.01 from the pins: a focused chat's mine, handed to the current mine once it is composed below. */
let focusChat = (mineId: MineId): void => {
  void mineId
}
const pins = useVallePins({
  bridge: props.bridge,
  stores,
  model,
  factsRead,
  talkedLast: () => stores.value.session.panelOpenChat ?? null,
  chatFocused: (mineId) => focusChat(mineId)
})
const mosaic = useValleMosaic({
  bridge: props.bridge,
  stores,
  model,
  factsRead,
  view: () => view.value,
  frontMine: () => frontMine.value,
  writeLayouts: (layouts) => preset.writeLayouts(layouts),
  dive: (mineId) => preset.send({ kind: 'dive', mineId }),
  swap: (mineId) => preset.send({ kind: 'pick', mineId }),
  showToast: (text) => showToast(text),
  // Every scroll to a zone goes through the reveal's (ISSUE-311): smooth, a jump under reduced motion, the scroll saved.
  scrollTo: (mineId) => {
    void nextTick(() => valleReveal.scrollIntoView(mineId))
  }
})
const columns = computed(() =>
  mosaic.order.value.map((mineId) => ({
    mineId,
    name: nameOf(mineId),
    enterable: enterable(mineId),
    content: mosaic.contentOf(mineId),
    tier: tierOf(mineId),
    portraits: crewCount(mineId)
  }))
)
/** The zone menu open on a Control room column, or on the Work front's zone. */
const columnMenu = computed(() => {
  const menu = mosaic.menu.value
  return menu?.zone.preset === 'control'
    ? { mineId: menu.zone.mineId, entries: menu.entries }
    : null
})
const frontMenu = computed(() => {
  const menu = mosaic.menu.value
  return menu?.zone.preset === 'front' ? menu.entries : null
})
/** "⋯" pressed: its menu opens, or closes when it is the one open (an outside press, S31.02). */
function toggleMenu(zone: ValleZoneKey): void {
  const open = mosaic.menu.value?.zone
  const same =
    open !== undefined &&
    open.preset === zone.preset &&
    (zone.preset === 'front' || (open.preset === 'control' && open.mineId === zone.mineId))
  if (same) mosaic.dismiss()
  else mosaic.openMenu(zone)
}

/** The Work front's mine: the one dived into or swapped in, else the last one worked in (S28.02, N-15). */
const frontMine = computed((): MineId | null => view.value.mineId ?? stores.value.lastFrontMineId)
/** A mine's tier, once measured. */
const tierOf = (mineId: MineId) =>
  model.mines.value.find((mine) => mine.id === mineId)?.tier ?? null
/** How many dwarfs a mine holds: its roster's portraits. */
const crewCount = (mineId: MineId): number =>
  model.dwarfs.value.filter((dwarf) => dwarf.mineId === mineId).length
const nameOf = (mineId: MineId): string =>
  model.mines.value.find((mine) => mine.id === mineId)?.name ?? ''
/** The Work front's list lines (`DS` organisms/mine-rows): each mine's tier and its crew line. */
const listMines = computed(() =>
  model.mines.value.map((mine) => ({
    mineId: mine.id,
    name: mine.name,
    tier: mine.tier,
    crew: mineRowCrew(crewCount(mine.id), mine.state !== 'unenterable')
  }))
)
const shownMine = computed(() => {
  const mineId = frontMine.value
  return mineId === null
    ? null
    : { mineId, name: nameOf(mineId), tier: tierOf(mineId), portraits: crewCount(mineId) }
})
const body = shallowRef<HTMLElement | null>(null)
const split = useValleSplit({
  bridge: props.bridge,
  pins,
  stores,
  factsRead,
  body,
  wish: () => view.value.layouts.front.split,
  writeWish: (on) => preset.wishSplit(on),
  foldedList: () => view.value.layouts.front.foldedList,
  portraits: () => model.dwarfs.value.filter((dwarf) => dwarf.mineId === frontMine.value).length,
  observe: props.bodyObserver ?? browserBodyObserver
})
const deckSplit = computed(() => ({ panes: split.panes.value, button: split.button.value }))

/*
 * The chats inside the pins (TVC): the Panel's own MessagePanel and Add panel in the stack's expanded line and in each
 * pane, fed by the window's one message dock. The pins on screen are the Control room's expanded line, or the Work
 * front's pane or panes.
 */
const chats = useValleChats({
  pins: () => pins.set.value,
  send: (input) => split.sendPin(input),
  shown: () =>
    view.value.preset === 'front'
      ? split.panes.value
      : pins.set.value.focus === null
        ? []
        : [pins.set.value.focus]
})

/** The chat in focus, carried by "▼ Panel" / "▼ Veta" (S28.21, machine 9): the focused chat pin's. */
const chat = computed((): { mineId: string; dwarfId: DwarfId } | null => {
  const set = pins.set.value
  const pin = set.pins.find((p) => p.key === set.focus)
  return pin?.kind === 'chat' ? { mineId: pin.mineId, dwarfId: pin.dwarfId } : null
})

/**
 * A chat carried into Valle by a mode run (07 S29.23, machine 9; ISSUE-311): pinned when absent and focused, its mine
 * made current, once the Host's facts are read and the pins restored; the run then restores its draft and view into
 * that chat, the one in focus. A dwarf no longer present is not pinned. Answers once it landed, or once the first read
 * of the Host's facts settled without them, so the hand-off waits for the chat's panel from then.
 */
function carriedIn(chat: CarriedChat): Promise<void> | void {
  const land = (): void => {
    split.sendPin({
      kind: 'carried',
      dwarfId: chat.dwarfId,
      mineId: chat.mineId,
      present: model.dwarfs.value.some((dwarf) => dwarf.id === chat.dwarfId)
    })
  }
  if (factsRead.value) {
    land()
    return
  }
  // The pins restore once the facts are read (a watcher of their own): the carried chat lands after them.
  return factsSettled.then(async () => {
    await nextTick()
    if (factsRead.value) land()
  })
}
const stopArrival = modeTransitionPart().onArrival(carriedIn)

/** The current mine (07 machine 35): marked, written for the Valle host and heard (ISSUE-307). */
const currentMine = useCurrentMine({
  bridge: props.bridge,
  facts: () => ({
    preset: view.value.preset,
    mosaic: mosaic.order.value,
    frontMine: frontMine.value,
    focusMine: (chat.value?.mineId as MineId | undefined) ?? null
  }),
  muted: () => model.mines.value.map((mine) => mine.id).filter((mineId) => mosaic.isMuted(mineId)),
  sound: audio
})
focusChat = (mineId) => {
  currentMine.send({ kind: 'chat', mineId })
}
// S35.03: the Work front's mine, dived into, swapped in or picked from the list, is made current.
watch(
  () => (view.value.preset === 'front' ? frontMine.value : null),
  (mineId) => {
    if (mineId !== null) currentMine.send({ kind: 'dive', mineId })
  },
  { immediate: true }
)
/**
 * The columns with the current mine marked, the mines needing the person wearing the needs-you ring, and the one a
 * needs-you jump called (ISSUE-306).
 */
const zoneColumns = computed(() =>
  columns.value.map((column) => ({
    ...column,
    current: column.mineId === currentMine.current.value,
    needs: model.dwarfs.value.some((dwarf) => dwarf.mineId === column.mineId && dwarf.needsYou),
    called: needsYou.called.value?.mineId === column.mineId ? needsYou.called.value.seq : 0
  }))
)
/** Every mine's ore, as the Map totals it: the top bar's strip (`DS` organisms/valle-bar `.dm-vbar__ore`). */
const oreTotals = computed(() => mapTotals(board.state.materials))
/** The board's mine behind a zone, as the Panel draws it (its tier, its crew), once the board has it. */
const boardMine = (mineId: MineId): Mine | null =>
  board.state.mines.find((mine) => mine.id === mineId) ?? null
/** A pinned chat's dwarf on the board, whose portrait leads its line or tab; null for an Add pin or one not yet read. */
const pinDwarf = (key: string): Dwarf | null =>
  board.state.mines.flatMap((mine) => mine.dwarfs).find((dwarf) => dwarf.id === key) ?? null
/** The dwarf whose chat is in focus: its sprite and portrait wear the selected look. */
const focusedDwarf = computed((): string | null => chat.value?.dwarfId ?? null)
/** A dwarf pressed in a zone, on its sprite or its roster portrait (S29.03…S29.05, S35.01, S35.07). */
function dwarfPressed(dwarf: Dwarf, mineId: MineId): void {
  // The dwarf speaks: a voice is never gated on the current mine (S35.07), as a click in the Panel's column.
  audio.playVoice(dwarf.role)
  split.sendPin({ kind: 'click', dwarfId: dwarf.id as DwarfId, mineId })
  // Its mine current even when its chat was already in focus (S35.01), as a pin selected is.
  currentMine.send({ kind: 'chat', mineId })
}
/** The roster's "+" or "+ Dwarf": the Add panel pinned and focused, aimed at the mine (S29.16). */
function addPressed(mineId: MineId): void {
  split.sendPin({ kind: 'add-open', mineId })
}
/** A sound of a zone's crew: the engine plays only the current mine's (US-VALLE-016.AC03). */
function crewSound(event: CrewSoundEvent): void {
  audio.playCrew(event)
}
/** A pin selected: its chat focused, and in the Control room its mine made current even when already in focus (S35.01). */
function selectPin(key: PinKey): void {
  split.sendPin({ kind: 'select', key })
  const pin = pins.set.value.pins.find((p) => p.key === key)
  if (pin?.kind === 'chat') currentMine.send({ kind: 'chat', mineId: pin.mineId })
}
/** The needs-you counter and queue (07 machine 34; ISSUE-306). */
const needsYou = useValleNeedsYou({
  model,
  preset: () => view.value.preset,
  frontMine: () => frontMine.value,
  // Each part through the composable that owns it, one writer per key; the preset is only read.
  jump: {
    reveal: (mineId) => mosaic.reveal(mineId),
    pin: (dwarfId, mineId) => {
      split.sendPin({ kind: 'jump', dwarfId, mineId })
    },
    current: (mineId) => currentMine.send({ kind: 'chat', mineId }),
    swap: (mineId, dwarfId) => preset.send({ kind: 'pick', mineId, dwarfId })
  }
})
/**
 * A needs-you jump, the counter's or an entry's (S34.05, S34.06): a nav page over the main zone gives way to the mines
 * first (S28.20), as the reveal does, so the jump lands where the person sees it (owner live check 2026-10-23).
 */
function jumpNeed(entry?: Parameters<typeof needsYou.pressEntry>[0]): void {
  if (view.value.page !== null) preset.send({ kind: 'escape', layerOpen: false })
  if (entry === undefined) needsYou.press()
  else needsYou.pressEntry(entry)
}
/** The mosaic's scroller, read from the drawn Control room. */
const mosaicEl = (): HTMLElement | null => room.value?.mosaic ?? null
/**
 * The reveal of a notification click while Valle is the mode (A-N16; 07 S39.06, S39.07; ADR-025 item 8; ISSUE-311):
 * each part through the composable that owns it, the preset only read, the mode never moved.
 */
const valleReveal = useValleReveal({
  view: () => ({ preset: view.value.preset, page: view.value.page, frontMine: frontMine.value }),
  present: (dwarfId) => model.dwarfs.value.some((dwarf) => dwarf.id === dwarfId),
  shown: () => shown.value,
  reduced,
  parts: {
    leavePage: () => preset.send({ kind: 'escape', layerOpen: false }),
    column: (mineId) => mosaic.reveal(mineId),
    pin: (dwarfId, mineId) => {
      split.sendPin({ kind: 'jump', dwarfId, mineId })
    },
    current: (mineId) => currentMine.send({ kind: 'chat', mineId }),
    swap: (mineId, dwarfId) => preset.send({ kind: 'pick', mineId, dwarfId })
  },
  scroller: {
    viewport: () => {
      const element = mosaicEl()
      return element === null
        ? null
        : { scrollLeft: element.scrollLeft, width: element.clientWidth }
    },
    zone: (mineId) => {
      const element = mosaicEl()
      const column = element?.querySelector(`[data-valle-column="${mineId}"]`)
      if (element === null || !(column instanceof HTMLElement)) return null
      const box = column.getBoundingClientRect()
      return {
        left: box.left - element.getBoundingClientRect().left + element.scrollLeft,
        width: box.width
      }
    },
    scrollTo: (left, behavior) => {
      const element = mosaicEl()
      if (element === null) return
      if (typeof element.scrollTo === 'function') element.scrollTo({ left, behavior })
      else element.scrollLeft = left
    }
  },
  patchUiSession: (patch) => props.bridge.patchUiSession(patch)
})
const stopReveal = props.bridge.onRevealDwarfChat((target) => {
  valleReveal.reveal(target)
})

// Valle's Settings page writes the Sound preferences alone: the engine adopts them when the page closes.
watch(
  () => view.value.page,
  (page, was) => {
    if (was === 'settings' && page !== 'settings') void audio.sync()
  }
)

/** The history drawer under the Work front's chats (07 machine 36; ISSUE-308). */
const drawerEl = shallowRef<{ $el: Element } | null>(null)
const historyDrawer = useValleHistoryDrawer({
  bridge: props.bridge,
  motion: {
    clock: props.clock ?? BROWSER_CLOCK,
    reduced,
    target: () => drawerEl.value?.$el ?? null,
    animate: (element, frames, timing) => {
      void parts.run(element, frames, timing)
    },
    cancel: (elements) => parts.cancel(elements),
    afterRender: (run) => {
      void nextTick(run)
    }
  }
})
/** The drawer while drawn: its mine and its state. */
const drawer = computed(() => {
  const state = historyDrawer.state.value
  return state.kind === 'closed' ? null : state
})
/** "Mine history" in the mine toolbar or the History bar: opens the drawer (S36.01), or sinks it when open (S36.03). */
function toggleHistory(mineId: MineId | null): void {
  if (drawer.value !== null) historyDrawer.send({ kind: 'close' })
  else if (mineId !== null) historyDrawer.send({ kind: 'open', mineId, preset: view.value.preset })
}
/** A mine-history request from a chat: the drawer in the Work front (S36.01), the mine's zone in the Control room (S31.11). */
function chatHistory(mineId: MineId): void {
  if (view.value.preset === 'front') historyDrawer.send({ kind: 'open', mineId, preset: 'front' })
  else mosaic.historyRequest(mineId)
}
// S36.04: a climb out closes it at once; S36.05: a swap keeps it open on the new mine.
watch(
  () => view.value.preset,
  (now) => {
    if (now !== 'front') historyDrawer.send({ kind: 'climb-out' })
  },
  { flush: 'sync' }
)
watch(
  () => (view.value.preset === 'front' ? frontMine.value : null),
  (mineId) => {
    if (mineId !== null) historyDrawer.send({ kind: 'swap', mineId })
  },
  { flush: 'sync' }
)
/** "▼ Panel" / "▼ Veta": leaving Valle closes the drawer at once (S36.04). */
function leave(move: MoveToModeParams): void {
  historyDrawer.send({ kind: 'leave' })
  preset.send({ kind: 'leave', move })
}

/** Valle's nav column: the slots whose page takes the main zone (S28.19), the Panel's own slots. */
const navSlots = (slots: readonly PanelNavSlot[]) =>
  slots.filter(
    (slot): slot is PanelNavSlot & { area: ValleNavPage } =>
      slot.area === 'map' || slot.area === 'mines' || slot.area === 'settings'
  )
/** In the Panel nav's groups (`DS` organisms/nav): World at the top, System at the foot. */
const NAV_GROUPS = [
  { name: 'World', slots: navSlots(WORLD_SLOTS) },
  { name: 'System', slots: navSlots(SYSTEM_SLOTS) }
]
/** The splitter and the chat zone it sizes (07 machine 33; ISSUE-305). */
const chatsEl = shallowRef<HTMLElement | null>(null)
const splitterEl = shallowRef<{ $el: Element } | null>(null)
const splitter = useValleSplitter({
  view: () => view.value,
  writeLayouts: (layouts) => preset.writeLayouts(layouts),
  bodyWidth: split.bodyWidth,
  foldedList: () => view.value.layouts.front.foldedList,
  portraits: () => model.dwarfs.value.filter((dwarf) => dwarf.mineId === frontMine.value).length,
  split: () => split.set.value.state === 'on',
  stores,
  motion: {
    clock: props.clock ?? BROWSER_CLOCK,
    reduced,
    // The zones' content the reset moves: the chat zone and the splitter beside it (`DS` `resetChatWidth`).
    targets: () =>
      [chatsEl.value, splitterEl.value?.$el ?? null].filter(
        (element): element is Element => element instanceof Element
      ),
    box: (element) => element.getBoundingClientRect(),
    animate: (element, frames, timing) => {
      void parts.run(element, frames, timing)
    },
    afterRender: (run) => {
      void nextTick(run)
    }
  }
})
const chatWidth = computed(() => `${splitter.width.value}px`)

/** "Reset preset" in the top bar's "⋯" menu (07 machine 37; ISSUE-309). */
const resetPreset = useValleResetPreset({
  view: () => view.value,
  resetLayouts: (layouts) => preset.resetLayouts(layouts),
  recomputeMosaic: () => {
    mosaic.resetPreset()
  },
  splitOff: () => {
    split.send({ kind: 'reset-preset' })
  },
  splitterRest: () => {
    splitter.send({ kind: 'reset' })
  },
  showToast: (text) => showToast(text),
  motion: {
    clock: props.clock ?? BROWSER_CLOCK,
    reduced,
    // The zones' content the reset moves: every zone drawn, the chat zone and the splitter beside it.
    targets: () =>
      [
        ...(rootEl.value?.querySelectorAll('[data-valle-zone]') ?? []),
        chatsEl.value,
        splitterEl.value?.$el ?? null
      ].filter((element): element is Element => element instanceof Element),
    box: (element) => element.getBoundingClientRect(),
    animate: (element, frames, timing) => {
      void parts.run(element, frames, timing)
    },
    afterRender: (run) => {
      void nextTick(run)
    }
  }
})
// A dive or a climb starting with the menu open closes it, as an outside press does (S37.02).
watch(
  () => resetPreset.offered.value,
  (offered) => {
    if (!offered) resetPreset.dismiss()
  }
)

/** A nav slot: its page over the main zone (S28.19); the Mines page reads the remembered projects again, as the Panel's. */
function nav(page: ValleNavPage): void {
  if (page === 'mines') void minesPage.load()
  preset.send({ kind: 'nav', page })
}

function onKey(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  // Esc closes the topmost layer first (NFR-A11Y-02): a menu that already took it, an open zone or slot menu, the
  // worktree question, the "⋯" preset menu; then a page, then the Work front.
  if (event.defaultPrevented || resetPreset.dismiss() || mosaic.dismiss()) return
  preset.send({ kind: 'escape', layerOpen: mosaic.worktree.value !== null })
}
const resized = (): void => {
  preset.send({ kind: 'resize' })
}
window.addEventListener('keydown', onKey)
window.addEventListener('resize', resized)

// The Host removed the mine the Work front shows: a swap to another, or a climb out at once (S28.23).
const stopFacts = model.onFacts((facts) => {
  for (const fact of facts) {
    if (fact.kind !== 'mine-removed') continue
    // S36.06 first: the drawer on that mine closes at once, before the Work front swaps or climbs out (S28.23).
    historyDrawer.send({ kind: 'mine-removed', mineId: fact.mineId })
    preset.send({ kind: 'mine-removed', mineId: fact.mineId })
  }
})

// Within the same run, the Control room opens at the mosaic's saved scroll, once its columns are drawn (S28.02).
const stopScroll = watch(
  () => columns.value.length,
  async (count) => {
    const saved = view.value.savedScroll
    if (count === 0 || saved === undefined || view.value.preset !== 'control') return
    stopScroll()
    await nextTick()
    const mosaic = room.value?.mosaic
    if (mosaic) mosaic.scrollLeft = saved
  }
)

let removeGate: (() => void) | null = null
onMounted(() => {
  if (rootEl.value !== null) removeGate = createInputGate(rootEl.value, gated)
  void model.start().then((read) => {
    if (read) factsRead.value = true
    settleFacts()
  })
  // The hosted pages' board and remembered projects (ISSUE-304).
  void board.start({ announce: false }).then(() => mapPage.loaded())
  void minesPage.load()
  // The sound (ISSUE-307): the stored settings and the page's visibility first, then the attention cues, judged
  // against the person's own Notification sounds (ISSUE-117).
  void audio.sync().then(() => {
    if (unmounted) return
    stopCues = useAttentionCues().start({
      settings: audio.settings,
      windowShown: audio.windowShown,
      playSfx: audio.playSfx
    })
  })
  stopAudio = audio.listen()
})
onUnmounted(() => {
  unmounted = true
  stopArrival()
  stopReveal()
  stopCues?.()
  stopAudio?.()
  currentMine.stop()
  historyDrawer.stop()
  audio.dispose()
  document.removeEventListener('visibilitychange', visibilityChanged)
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('resize', resized)
  removeGate?.()
  stopFacts()
  stage.end()
  parts.dispose()
  model.stop()
  board.stop()
})
</script>

<template>
  <main
    ref="rootEl"
    class="valle"
    data-valle-root
    :data-preset="view.preset"
    :data-motion="view.motion?.kind ?? 'none'"
    :data-page="view.page ?? 'mines'"
    :data-held="held"
  >
    <ValleTopBar
      :preset="view.preset"
      :chat="chat"
      :menu-open="resetPreset.menuOpen.value"
      :offered="resetPreset.offered.value"
      @tab="(target) => preset.send({ kind: 'tab', preset: target })"
      @arrow="(key) => preset.send({ kind: 'arrow', key })"
      @leave="leave"
      @menu="resetPreset.toggle()"
      @reset="resetPreset.reset()"
      @menu-dismiss="resetPreset.dismiss()"
    >
      <template #ore>
        <VaultStrip :ore="oreTotals" label="Ore" :max="6" />
      </template>
      <template #counter>
        <NeedsYouCounter :view="needsYou.counter.value" :still="still" @press="jumpNeed()" />
      </template>
    </ValleTopBar>
    <div ref="body" class="dm-valle__body" :style="{ '--chat-w': chatWidth }">
      <nav class="dm-valle__nav m-mat" aria-label="Valle">
        <div
          v-for="group in NAV_GROUPS"
          :key="group.name"
          class="dm-valle__navgroup"
          role="group"
          :aria-label="group.name"
        >
          <NavSlot
            v-for="slot in group.slots"
            :key="slot.id"
            :icon="slot.icon"
            :label="slot.label"
            :data-slot="slot.id"
            :current="slot.area === view.page"
            @click="nav(slot.area)"
          />
        </div>
      </nav>
      <ValleNavPageView v-if="view.page !== null" :page="view.page">
        <ValleHostedPage
          v-if="view.page === 'map' || view.page === 'mines'"
          :page="view.page"
          @open="(mineId) => openMine(mineId as MineId)"
        />
        <ValleSettingsPage v-else @close="preset.send({ kind: 'escape', layerOpen: false })" />
      </ValleNavPageView>
      <ValleWorkFront
        v-else-if="view.preset === 'front'"
        :folded-list="view.layouts.front.foldedList"
        :mines="listMines"
        :mine="shownMine"
        :closed="shownMine !== null && !enterable(shownMine.mineId)"
        :content="mosaic.frontContent.value"
        :menu="frontMenu"
        :moving="gated()"
        :history-open="drawer !== null"
        @menu="toggleMenu({ preset: 'front' })"
        @menu-pick="(id) => mosaic.pickMenu(id)"
        @menu-dismiss="mosaic.dismiss()"
        @fold="preset.send({ kind: 'fold' })"
        @unfold="preset.send({ kind: 'unfold' })"
        @pick="(mineId) => preset.send({ kind: 'pick', mineId })"
        @current="(mineId) => currentMine.send({ kind: 'painting', mineId })"
        @history="toggleHistory"
        @add="addPressed"
      >
        <template #art="{ mineId }">
          <ValleMineArt
            v-if="boardMine(mineId) !== null"
            :mine="boardMine(mineId)!"
            :selected-id="focusedDwarf"
            @dwarf="(dwarf) => dwarfPressed(dwarf, mineId)"
            @crew-sound="crewSound"
          />
        </template>
        <template #roster="{ mineId }">
          <CrewRoster
            v-if="boardMine(mineId) !== null"
            :dwarfs="mineCrew(boardMine(mineId)!)"
            :selected-id="focusedDwarf"
            @pick="(dwarf) => dwarfPressed(dwarf, mineId)"
          />
        </template>
        <template #content="{ mineId, content }">
          <ValleZoneHistory
            v-if="content === 'history'"
            :mine-id="mineId"
            @close="mosaic.showMine({ preset: 'front' })"
          />
          <ValleHostedPage
            v-else
            page="map"
            @open="(id) => mosaic.mapMarker({ preset: 'front' }, id as MineId)"
          />
        </template>
      </ValleWorkFront>
      <ValleControlRoom
        v-else
        ref="room"
        :columns="zoneColumns"
        :menu="columnMenu"
        :slot-entries="mosaic.slot.value"
        :notice="mosaic.notice.value"
        :moving="gated()"
        :still="still"
        @menu="(mineId) => toggleMenu({ preset: 'control', mineId })"
        @menu-pick="(id) => mosaic.pickMenu(id)"
        @menu-dismiss="mosaic.dismiss()"
        @slot-open="mosaic.openSlot()"
        @slot-dismiss="mosaic.dismiss()"
        @slot-pick="(mineId) => mosaic.pickSlot(mineId)"
        @slot-new="mosaic.newProject()"
        @dive="(mineId) => preset.send({ kind: 'dive', mineId })"
        @sprite-double-click="preset.send({ kind: 'sprite-double-click' })"
        @current="(mineId) => currentMine.send({ kind: 'painting', mineId })"
        @add="addPressed"
      >
        <template #art="{ mineId }">
          <ValleMineArt
            v-if="boardMine(mineId) !== null"
            :mine="boardMine(mineId)!"
            :selected-id="focusedDwarf"
            @dwarf="(dwarf) => dwarfPressed(dwarf, mineId)"
            @crew-sound="crewSound"
          />
        </template>
        <template #roster="{ mineId }">
          <CrewRoster
            v-if="boardMine(mineId) !== null"
            :dwarfs="mineCrew(boardMine(mineId)!)"
            :selected-id="focusedDwarf"
            @pick="(dwarf) => dwarfPressed(dwarf, mineId)"
          />
        </template>
        <template #content="{ mineId, content }">
          <ValleZoneHistory
            v-if="content === 'history'"
            :mine-id="mineId"
            @close="mosaic.showMine({ preset: 'control', mineId })"
          />
          <ValleHostedPage
            v-else-if="content === 'map'"
            page="map"
            @open="(id) => mosaic.mapMarker({ preset: 'control', mineId }, id as MineId)"
          />
          <ValleHostedPage v-else page="mines" @open="(id) => openMine(id as MineId)" />
        </template>
      </ValleControlRoom>
      <ValleSplitter
        ref="splitterEl"
        :width="splitter.width.value"
        :min="splitter.range.value.min"
        :max="splitter.range.value.max"
        :dragging="splitter.set.value.state === 'dragging'"
        @press="(x) => splitter.send({ kind: 'press', x })"
        @move="(x) => splitter.send({ kind: 'move', x })"
        @release="splitter.send({ kind: 'release' })"
        @cancel="splitter.send({ kind: 'cancel' })"
        @key="(key) => splitter.send({ kind: 'key', key })"
        @reset="splitter.send({ kind: 'double-click' })"
      />
      <aside ref="chatsEl" class="dm-valle__chats" aria-label="Pinned chats">
        <PinnedStack
          v-if="view.preset === 'control'"
          :pins="pins.views.value"
          :focus="pins.set.value.focus"
          :focus-request="pins.focusRequest.value"
          @select="selectPin"
          @unpin="(key) => split.sendPin({ kind: 'unpin', key })"
        >
          <template #portrait="{ pin }">
            <DwarfPortrait
              v-if="pinDwarf(pin.key) !== null"
              :role="pinDwarf(pin.key)!.role"
              :status="sceneDwarfStatus(pinDwarf(pin.key)!)"
              class="dm-vpin__portrait"
              size="sm"
            />
          </template>
          <template #chat="{ pin }">
            <ValleChat
              :pin="pin"
              :dock="chats.dock"
              :mine-name="nameOf(pin.mineId)"
              :in-focus="pin.key === pins.set.value.focus"
              @close="split.sendPin({ kind: 'unpin', key: pin.key })"
              @history="chatHistory(pin.mineId)"
            />
          </template>
        </PinnedStack>
        <ChatDeck
          v-else
          :pins="pins.views.value"
          :focus="pins.set.value.focus"
          :focus-request="pins.focusRequest.value"
          :split="deckSplit"
          :history="frontMine === null ? null : { open: drawer !== null }"
          @select="selectPin"
          @unpin="(key) => split.sendPin({ kind: 'unpin', key })"
          @drag="(key) => split.sendPin({ kind: 'drag', key })"
          @drop="(order) => split.sendPin({ kind: 'drop', order })"
          @drag-cancel="split.sendPin({ kind: 'drag-cancel' })"
          @split="split.press()"
          @history="toggleHistory(frontMine)"
        >
          <template #portrait="{ pin }">
            <DwarfPortrait
              v-if="pinDwarf(pin.key) !== null"
              :role="pinDwarf(pin.key)!.role"
              :status="sceneDwarfStatus(pinDwarf(pin.key)!)"
              class="dm-vpin__portrait"
              size="sm"
            />
          </template>
          <template #chat="{ pin }">
            <ValleChat
              :pin="pin"
              :dock="chats.dock"
              :mine-name="nameOf(pin.mineId)"
              :in-focus="pin.key === pins.set.value.focus"
              @close="split.sendPin({ kind: 'unpin', key: pin.key })"
              @history="chatHistory(pin.mineId)"
            />
          </template>
          <template #drawer>
            <HistoryDrawer
              v-if="drawer !== null"
              ref="drawerEl"
              :mine-id="drawer.mineId"
              :state="drawer.kind"
              @close="historyDrawer.send({ kind: 'close' })"
            />
          </template>
        </ChatDeck>
      </aside>
      <!-- The toast contract's host over the main zone alone (BR-23; 07 §24 I-38): never over the chat zone. -->
      <div class="dm-valle__toasts" data-valle-toasts>
        <ToastHost />
      </div>
    </div>
    <NeedsYouQueue :entries="needsYou.entries.value" @press="(entry) => jumpNeed(entry)" />
    <div class="dm-vghosts" aria-hidden="true"></div>
    <WorktreeDialog
      :question="mosaic.worktree.value"
      :adding="mosaic.adopting.value"
      @accept="mosaic.answerWorktree(true)"
      @dismiss="mosaic.answerWorktree(false)"
    />
  </main>
</template>

<style scoped>
/* `DS/docs/screens/valle.md` Parts, `.dm-valle`: one rock ground with its frame, three rows 6 px apart. */
.valle {
  position: relative;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  gap: 6px;
  width: 100vw;
  height: 100vh;
  padding: 6px;
  overflow: hidden;
  background: var(--rock);
  box-shadow: inset 0 -2px 0 0 var(--rock-lo);
}
.dm-valle__body {
  position: relative;
  display: grid;
  grid-template-columns: 56px minmax(0, 1fr) 12px var(--chat-w);
  gap: 6px;
  min-width: 0;
  min-height: 0;
}
/*
 * The area the general toast rule centres on (BR-23): the main zone, between the nav column and the splitter (nav 56 and
 * gap 6 on the left; the chat zone, its gap, the 12 px splitter and its gap on the right). The toast stands
 * 56 px above its bottom, so it never lies over the chat zone or a composer; the design's own Valle rule is open (07 §24
 * I-38). It takes no pointer.
 */
.dm-valle__toasts {
  position: absolute;
  inset-block: 0;
  inset-inline-start: 62px;
  inset-inline-end: calc(var(--chat-w) + 24px);
  pointer-events: none;
}
/* The Panel nav's plate (`DS` organisms/nav, nav.css): wood, 56 px, its groups top and foot. */
.dm-valle__nav {
  --mat-fill: var(--wood-lo);
  --mat-hi: var(--wood);
  --mat-lo: var(--rock-lo);
  --mat-edge: var(--rock-lo);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: space-between;
  min-height: 0;
  padding: 8px 0 10px;
}
.dm-valle__navgroup {
  display: grid;
  justify-items: center;
  gap: 6px;
}
/* A pinned chat's portrait sits flush in its line or tab (`DS` chat-stack.css, chat-tab.css: `.dm-portrait { margin: 0 }`). */
.dm-vpin__portrait {
  margin: 0;
}
.dm-vghosts {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.dm-valle__chats {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
</style>
