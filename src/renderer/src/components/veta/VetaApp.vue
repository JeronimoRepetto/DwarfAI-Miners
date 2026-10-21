<script setup lang="ts">
/*
 * The Veta window's root (ADR-025 item 1; ISSUE-285): its own renderer of the same bundle, mounted for `?mode=veta`.
 * The window around it is transparent and hugs the island.
 *
 * The island shows Veta's life state (07 machine 20; US-VETA-001; ISSUE-287), derived from the Host facts and never
 * picked by the person (`useVetaLife`):
 * - `first-run` and `no-sessions`: the closed entrance is the only part and the one click target (US-VETA-011.AC04),
 *   with "+" on first run. It moves to the Panel with no mine (S20.12), or, on first run, opens the empty mine picker
 *   (S20.13, S22.08).
 * - `all-idle` and `sessions-working`: parts from the anchor outward, expand, one chamber per mine at work, "+N" and
 *   the grip. DOM order is visual order: anchored at the right or bottom end it runs grip, "+N", the chambers
 *   last-seen first, expand. Mines keep their first-seen order, so a lit chamber never jumps.
 * - Before the Host has answered, nothing is drawn.
 *
 * The window hugs the island: its length along the edge is reported to UI main (`layoutVeta {island-resize}`, A-N23)
 * each time it changes, its thickness is `VETA_ISLAND.thickness`. The drawn chambers are reported as the mines on
 * screen (A-44, S20.18); a mine folded into "+N" is not on screen (S25.10, BR-02).
 *
 * The overflow (ISSUE-291; 07 machine 25, carried out by `useVetaOverflow`; UC-049): as many chambers as fit the
 * stage's length along the edge show, up to four, and the rest fold into "+N" (`VetaOverflow`). The fit is measured
 * again, debounced, on show, on an edge or display change, on a window resize and on a chamber set change; the wheel
 * over the strip cycles the visible run. A longer island grows the window before it is drawn (`layoutVeta
 * {island-resize}` first, S21.19). Hovering "+N" shows the folded mines, in a room the band holds for good with the
 * tabs' and the labels', so a hover never resizes the window; a click on one unfolds its chamber (`layoutVeta
 * {unfold-overflow}`) and opens the chat of its dwarf that needs the person, oldest first, else the one last talked to
 * there, else the first of its crew (S25.11; OQ-76 A). A reveal for a folded mine unfolds its chamber the same way
 * before the chat rises (S25.08).
 *
 * The dock (ISSUE-286; 07 machine 21): while the grip is dragged the window is the drag surface (the work area of the
 * display under the pointer): the island follows the pointer by transform and the dashed snap preview marks where it
 * would land.
 *
 * The grip menu and the mine picker (ISSUE-288; 07 machine 22, carried out by `useMinePicker`): a grip click that did
 * not drag, a right-click, Enter or Space opens the menu; "New dwarf in…" or the first-run "+" opens the picker. Each is
 * an overlay beside the island on the screen side, aligned to its anchored end (`vetaOverlayFrame`, which UI main
 * places the window by): the window grows for it before it shows and shrinks back after it has gone
 * (`useVetaOverlay`). Out of a drag the island is pinned to its edge and anchored end, so a window growing around it
 * never moves it. Esc, a press outside the overlay, or the window losing the focus closes it and the focus goes back
 * to its opener; a drag, a mode change or the window hidden closes it silently. Over the overlay's transparent room
 * the mouse goes through to whatever is below (`useVetaClickThrough`, ADR-025 item 4). A worktree folder picked by Add a
 * mine asks the Mines page's worktree question first, over a window grown to hold it (US-MINES-004.AC03).
 *
 * The mine tab (ISSUE-289; 07 machine 23, `stepMineTab`; UC-047): hovering a chamber, or keyboard focus in it, raises
 * its tab, the chamber under the pointer winning over the one holding focus, so never more than one rises. "▢" moves to
 * the Panel on that mine (A-N13), "+" asks for the Add panel aimed at it (S24.03, ISSUE-290's rise). The tab goes with
 * its chamber and closes when a drag starts. The window holds the band the tabs rise into for good while chambers are
 * drawn (07 §24 I-22, `layoutVeta {overlay}`, measured from the tabs' boxes), so a hover never resizes it, and the band
 * is click-through except over a risen tab (`vetaTakesPointer`).
 *
 * The risen window (ISSUE-290; 07 machine 24; UC-048, UC-066; BR-21), carried out by `useVetaRisen`: a click, Enter or
 * Space on a dwarf's sprite rises its chat above the strip, anchored by its pointer to that dwarf; a mine tab's "+" or a
 * picker pick rises the Add panel aimed at that mine, and a launch from it turns it into the new dwarf's chat where it
 * stands. Both are the Panel's own components, fed by the Panel's own `useMessageDock` over this window's own board
 * (`useMines`), so a chat in Veta has every feature it has in the Panel; only its anchor differs. A press outside it in
 * this window (the strip included) or Esc folds it with the draft kept; a press on another dwarf replaces it. Its dwarf
 * departing leaves it read-only or, for a removed mine, closes it; a drag, the display going away or the window hidden
 * fold it at once. A click in another app does not fold it: the OS file picker and the console the chat itself opens
 * take the focus the same way, and would fold the chat under the person's hands. Hovering a dwarf shows its one-line
 * label, whose room the band holds for good with the tabs', so a hover never resizes the window.
 *
 * The chat hand-off (ISSUE-293; 07 machine 9, S24.12, S24.18; UC-051): the risen chat's "▢ Open in the Panel" asks for
 * the Panel on its mine and dwarf, the run flushing its draft, scroll anchor and caret; a run into Veta carrying a chat
 * rises it once the shell motion landed, M + 60 ms after `t0`, its draft and view given back by the session store.
 *
 * Arrivals and departures (ISSUE-292; 07 machine 26; UC-050), carried out by `useVetaChoreography` while Veta is the
 * shown mode, from the `dwarf.arrived` and `dwarf.departed` frames alone: the strip drawn is its staged one, so an
 * arrival is held back until the window has grown for it and a departed dwarf stands until it has walked out. From the
 * closed entrance the lamp lights, the island is built at its final size with its parts fading in from the anchor side,
 * then the dwarfs walk in; into a drawn chamber only the dwarf walks in, its chamber's lamp brightening; a new chamber
 * opens last, by "+N"; a departure walks out away from the anchor while fading, an emptied chamber fades and what lay
 * beyond slides back, and the last one contracts the strip to the entrance. The window grows before a growth and
 * shrinks after the motion, never during one: the length and the tab band wait while anything moves. This window plays
 * the motion (`play`) on the bounded runner (`createVetaMotion`), transform and opacity only, 0 ms under reduced motion
 * and with the lantern steady. A departing dwarf's risen chat follows S24.10 / S24.11 as it walks out. No sound plays.
 *
 * The Host connection lost (ISSUE-296; UC-067; ADR-002 D9; ADR-033 item 3): while it is not `connected` the strip is
 * held as last known, read-only (`data-held`), every chamber and dwarf kept and nothing walked; the snapshot read once
 * it is back is applied with no choreography: a dwarf missing from it vanishes, a new one stands at its station, and a
 * risen chat of a missing dwarf closes with no walk, its draft dropped (S20.16, S26.15). The Panel's one Host-state
 * message with its Retry shows in this window (`VetaHostState`), over a window first grown to the risen window's room
 * (DR-03), and the mode never changes to show it; while it shows the window takes the pointer and nothing behind it
 * folds. Every shrink of the window, a re-snapshot's included, waits for the "+N" hover gate.
 */
import { VETA_ISLAND, type DwarfId, type DwarfWire, type MineId } from '@dwarfai/contracts'
import type { MineWorktreeOf } from '../../types'
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch,
  type CSSProperties
} from 'vue'
import { useDwarfMessaging } from '../../composables/useDwarfMessaging'
import { useMessageDock } from '../../composables/useMessageDock'
import { useMines } from '../../composables/useMines'
import { useWindowMinePicker } from '../../composables/useMinePicker'
import { useVetaChoreography, type VetaCue } from '../../composables/useVetaChoreography'
import { useWindowVetaClickThrough, vetaTakesPointer } from '../../composables/useVetaClickThrough'
import { useWindowVetaDock } from '../../composables/useVetaDock'
import { useWindowVetaLife, useWindowVetaOverflow } from '../../composables/useVetaLife'
import { useWindowVetaOverlay } from '../../composables/useVetaOverlay'
import { useWindowVetaPresence } from '../../composables/useVetaPresence'
import { useWindowVetaRisen } from '../../composables/useVetaRisen'
import { modeTransitionPart } from '../../composables/useModeTransition'
import { prefersReducedMotion } from '../../lib/scene/sceneMotion'
import { SHIPPED_MODES } from '../../lib/shell/builtDestinations'
import {
  VETA_MOTION,
  chamberOpenFrames,
  enterFrames,
  fadeOutFrames,
  flipFrames,
  opensChamber,
  outwardOf,
  partFrames,
  walkInFrames,
  walkOutFrames
} from '../../lib/veta/choreography'
import { snapRect } from '../../lib/veta/dockGesture'
import { dwarfLabels, labelBox, silenceOf } from '../../lib/veta/dwarfLabel'
import { gripMenuEntries, type GripMenuItemId, type Opener } from '../../lib/veta/gripMenu'
import { islandLength } from '../../lib/veta/island'
import { entranceIntent } from '../../lib/veta/lifeState'
import { drawnRun, dwarfToOpen, fitRun, islandOf, partAt } from '../../lib/veta/overflow'
import { createVetaMotion } from '../../lib/veta/vetaMotion'
import type { VetaChamberView } from '../../lib/veta/lifeState'
import {
  PLAIN_MINE_TAB,
  aimOf,
  stepMineTab,
  tabBand,
  type MineTab,
  type MineTabEvent,
  type TabBox
} from '../../lib/veta/mineTab'
import WorktreeDialog from '../browse/WorktreeDialog.vue'
import MinePicker from './MinePicker.vue'
import VetaChamber from './VetaChamber.vue'
import VetaEntrance from './VetaEntrance.vue'
import VetaExpand from './VetaExpand.vue'
import VetaGrip from './VetaGrip.vue'
import VetaGripMenu from './VetaGripMenu.vue'
import VetaIsland from './VetaIsland.vue'
import VetaOverflow from './VetaOverflow.vue'
import DwarfLabel from './DwarfLabel.vue'
import VetaRisen from './VetaRisen.vue'
import VetaHostState from './VetaHostState.vue'
import { risenGeometry, type RisenContent } from '../../lib/veta/risenWindow'

const life = useWindowVetaLife()
const { state, chambers } = life

/*
 * Machine 26 (ISSUE-292): the strip drawn is the choreography's staged one. The closed entrance shows while no chamber
 * is drawn and either no dwarf is present or the first arrivals are still held back behind the lit lamp; a departed
 * last dwarf keeps the strip drawn until it has walked out.
 */
const choreo = useVetaChoreography({
  facts: () => chambers.value,
  onFacts: (listener) => life.onFacts(listener),
  shown: () => life.shown.value,
  reduced: () =>
    prefersReducedMotion() ||
    document.hidden ||
    typeof HTMLElement.prototype.animate !== 'function',
  drawn: () => drawnChambers.value.map((c) => c.mine.id),
  opens: (_mineId, crew) => opens(crew),
  fit: (now) => overflow.measureFor(now),
  grow: (now) => growFor(now),
  shrink: () => {
    held = null
    void placeAfterMotion()
    return Promise.resolve()
  },
  fold: () => overflow.measure(),
  play: (cue) => play(cue),
  cancel: (dwarfIds) => cancelMotion(dwarfIds),
  chat: (dwarfId, cause) => void risen.dispatch({ type: 'departed', dwarfId, cause })
})
const staged = choreo.chambers

const closed = computed(
  () =>
    state.value !== null &&
    staged.value.length === 0 &&
    (state.value === 'first-run' || state.value === 'no-sessions' || choreo.holding.value)
)
const sessions = computed(() => state.value !== null && !closed.value)

const root = ref<HTMLElement | null>(null)

/** Gives the focus back to what opened an overlay (S22.03, S22.16), when it is still drawn. */
function focusOpener(target: Opener): void {
  const selector = target === 'grip' ? '[data-veta-grip]' : '[data-veta-entrance]'
  root.value?.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true })
}

/** What asked for the Add panel: a mine tab's "+", or a pick in the picker the grip or the entrance opened. */
let addFrom: 'tab' | 'picker' = 'tab'

const picker = useWindowMinePicker({
  mines: () => life.mines.value,
  built: SHIPPED_MODES,
  focus: focusOpener,
  addPanel: (mineId) => {
    addFrom = 'picker'
    void risen.dispatch({ type: 'add', mineId })
  }
})
const menuEntries = gripMenuEntries(SHIPPED_MODES)

/** A press that closed an overlay on the grip or the entrance does not open one again on its release. */
let swallow = false

/** A growth asked for before the island draws it (S21.19): the length UI main places the window for meanwhile. */
let growing: number | null = null
/** The length a growth already placed the window for, so drawing it asks for nothing more. */
let grown: number | null = null
/** The length machine 26 placed the window for before its motion, held until the motion has ended. */
let held: number | null = null
/** The dock has placed the island once: a length change re-places it from then on. */
let started = false

// The dock reads the island's length only once mounted, after `length` below exists.
const dock = useWindowVetaDock(
  () => growing ?? held ?? length.value,
  () => {
    if (swallow) swallow = false
    else picker.dispatch({ type: 'grip-click', dragging: false })
  }
)
const { vertical, dragging, preview, follow } = dock

/** The stage's length along the edge (`setLength`): its width on a top or bottom edge, its height on a side one. */
function stageLength(): number {
  return vertical.value ? window.screen.availHeight : window.screen.availWidth
}

const overflow = useWindowVetaOverflow({
  chambers: () => staged.value,
  available: stageLength,
  vertical: () => vertical.value,
  async grow(to) {
    if (!started) return
    growing = to
    try {
      await dock.resized()
    } finally {
      growing = null
    }
    grown = to
  }
})
const { drawn: drawnChambers, folded } = overflow
const listShown = computed(() => overflow.machine.value.state === 'list-shown')

/** The island's length along its edge: the closed entrance's, or the strip's parts added up, "+N" with them. */
const length = computed(() =>
  sessions.value
    ? islandLength(
        {
          kind: 'chambers',
          crews: drawnChambers.value.map((c) => c.dwarfs.length),
          folded: folded.value.length > 0
        },
        vertical.value
      )
    : VETA_ISLAND.length
)
const anchorEnd = computed(() => dock.dock.value.end === 'end')
const ordered = computed(() =>
  anchorEnd.value ? [...drawnChambers.value].reverse() : drawnChambers.value
)

/** The island these chambers would draw, with the overflow's run as it would be measured for them (S25.02, S25.03). */
function lengthFor(now: readonly VetaChamberView[]): number {
  const layout = {
    crews: now.map((c) => c.dwarfs.length),
    available: stageLength(),
    vertical: vertical.value
  }
  if (layout.crews.length === 0) return VETA_ISLAND.length
  const machine = overflow.machine.value
  const run =
    machine.state === null || machine.state === 'fits'
      ? fitRun(layout, machine.first)
      : drawnRun(machine, layout.crews.length)
  return islandOf(layout, run)
}

/** S26.05 or S26.18: a new chamber of `crew` dwarfs opens last, unless four are drawn or the edge has no room. */
function opens(crew: number): boolean {
  const total = staged.value.length + 1
  const run = drawnRun(overflow.machine.value, total)
  if (run.first + run.count < total) return false
  return opensChamber(
    {
      drawnCrews: drawnChambers.value.map((c) => c.dwarfs.length),
      folded: folded.value.length > 0,
      available: stageLength(),
      vertical: vertical.value
    },
    crew
  )
}

/** Before a growth (S26.01, S26.04, S26.05; S21.19): the window is placed for the final island, anchor fixed. */
async function growFor(now: readonly VetaChamberView[]): Promise<void> {
  if (!started) return
  const to = lengthFor(now)
  if (to <= (held ?? length.value)) return
  held = to
  await placeIsland()
}

/** The length UI main placed the window for last. */
let placed: number | null = null

/** Places the window for the island (`layoutVeta {island-resize}`): the held length while a growth waits for it. */
function placeIsland(): Promise<void> {
  if (!started) return Promise.resolve()
  if (!choreo.moving.value) held = null
  placed = growing ?? held ?? length.value
  return dock.resized()
}

/*
 * The one hover gate (ISSUE-292): a window resized under the pointer closes what it hovers (the "+N" list, ISSUE-291),
 * so every shrink waits for the pointer to leave it: machine 26's after a motion, and machine 24's after a fold.
 */
let unhovered: Array<() => void> = []
/** While the "+N" list is under the pointer, resolves once it has left it; `undefined` when nothing is hovered. */
function whenUnhovered(): Promise<void> | undefined {
  if (!listShown.value) return undefined
  return new Promise((resolve) => unhovered.push(resolve))
}
watch(
  () => listShown.value,
  (shown) => {
    if (shown) return
    const waiting = unhovered
    unhovered = []
    for (const resolve of waiting) resolve()
  }
)

/** After a motion (S26.09, S26.11): the window is placed for the island as drawn, once nothing hovered is under it. */
async function placeAfterMotion(): Promise<void> {
  await whenUnhovered()
  // Another shrink already placed it meanwhile, or a new motion will place it after it ends.
  if (choreo.moving.value || placed === length.value) return
  await placeIsland()
}

// Once nothing moves, the window is placed for the island as drawn, when that changed meanwhile (never mid-motion).
watch(
  () => choreo.moving.value,
  (now) => {
    if (now) return
    held = null
    if (started && placed !== length.value) void placeAfterMotion()
  }
)

useWindowVetaPresence(() => ({
  state: state.value,
  shown: life.shown.value,
  drawn: drawnChambers.value.map((c) => c.mine.id)
}))

/**
 * A wheel notch over the strip cycles the visible run (S25.04); with everything drawn it does nothing (S25.09). The
 * pointer rests where it was, now over another chamber or none: the hovered chamber is resolved again from where the
 * notch landed along the island, so the risen tab is the one under the pointer (S23.02), or none (S23.03), and the
 * hover label is the one of the dwarf under it, or none (S24.19).
 */
async function wheeled(event: WheelEvent): Promise<void> {
  if (!sessions.value || dragging.value) return
  const delta = event.deltaY !== 0 ? event.deltaY : event.deltaX
  if (delta === 0) return
  const box = root.value?.querySelector<HTMLElement>('[data-veta-island]')?.getBoundingClientRect()
  const along =
    box === undefined ? null : vertical.value ? event.clientY - box.top : event.clientX - box.left
  await overflow.wheel(delta)
  if (along === null) return
  const under = partAt(
    {
      mines: drawnChambers.value.map((c) => ({
        mineId: c.mine.id,
        dwarfs: c.dwarfs.map((d) => d.id)
      })),
      folded: folded.value.length > 0,
      vertical: vertical.value,
      anchorEnd: anchorEnd.value
    },
    along
  )
  pointerOn.value = under?.mineId ?? null
  const dwarfId = under?.dwarfId ?? null
  pointerDwarf.value = { dwarfId, stamp: pointerDwarf.value.stamp + 1 }
  dwarfHover(dwarfId)
}

/** The dwarf under a resting pointer after a wheel notch, for the chambers to show its label (stamped per notch). */
const pointerDwarf = shallowRef<{ dwarfId: DwarfId | null; stamp: number }>({
  dwarfId: null,
  stamp: 0
})

/** A right-click, or Enter or Space on the grip (S22.02); a right-click that just closed the menu does not reopen it. */
function gripMenu(): void {
  if (swallow) swallow = false
  else picker.dispatch({ type: 'grip-open' })
}

function enter(): void {
  if (state.value === null) return
  if (swallow) {
    swallow = false
    return
  }
  const intent = entranceIntent(state.value)
  if (intent === 'open-panel') life.openPanel()
  else if (intent === 'open-picker') picker.dispatch({ type: 'entrance' })
}

/** The last pointer position in the window, for the snap preview. */
const pointer = ref({ x: 0, y: 0 })
const surface = ref({ width: 0, height: 0 })

const facts = (event: PointerEvent) => ({
  screenX: event.screenX,
  screenY: event.screenY,
  clientX: event.clientX,
  clientY: event.clientY
})

function move(event: PointerEvent): void {
  surface.value = { width: window.innerWidth, height: window.innerHeight }
  pointer.value = { x: event.clientX, y: event.clientY }
  dock.pointerMove(facts(event), surface.value)
}

function key(event: KeyboardEvent): void {
  if (dock.keyDown(event.key)) event.preventDefault()
}

/** Out of a drag the island keeps to its edge and its anchored end; dragged, it follows the pointer from the corner. */
const islandStyle = computed<CSSProperties>(() => {
  if (dragging.value) {
    return { left: '0', top: '0', transform: `translate(${follow.value.x}px, ${follow.value.y}px)` }
  }
  const { edge, end } = dock.dock.value
  const sideways = edge === 'left' || edge === 'right'
  return {
    left: (sideways ? edge === 'left' : end === 'start') ? '0' : 'auto',
    right: (sideways ? edge === 'right' : end === 'end') ? '0' : 'auto',
    top: (sideways ? end === 'start' : edge === 'top') ? '0' : 'auto',
    bottom: (sideways ? end === 'end' : edge === 'bottom') ? '0' : 'auto'
  }
})

const snapStyle = computed(() => {
  if (preview.value === null) return undefined
  const rect = snapRect(preview.value, pointer.value, surface.value, {
    length: length.value,
    thickness: VETA_ISLAND.thickness
  })
  return {
    left: `${rect.x}px`,
    top: `${rect.y}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`
  }
})

/*
 * The overlays (07 machine 22): which one shows, and the room it takes beside the island. The picker stays drawn while
 * the folder dialog is open and the folder is declared.
 */
const overlay = useWindowVetaOverlay()
const overlayKind = computed<'menu' | 'picker' | null>(() => {
  const now = picker.state.value
  if (now === 'menu-open') return 'menu'
  return now === 'closed' ? null : 'picker'
})
/** The gap between the island and the overlay (DS: the menu's `DM.place` default 6 px, the picker's 8 px). */
const OVERLAY_GAP = { menu: 6, picker: 8 } as const
/** The room the overlay card's drop shadow (`.m-raised`, 4 px right and down) needs. */
const SHADOW = 4

const overlayBox = ref<HTMLElement | null>(null)
const menuRef = ref<InstanceType<typeof VetaGripMenu> | null>(null)
const pickerRef = ref<InstanceType<typeof MinePicker> | null>(null)

/** The overlay box beside the island: on the screen side, at the anchored end, with its gap and its shadow's room. */
const overlayStyle = computed<CSSProperties>(() => {
  const { edge, end } = dock.dock.value
  const gap = overlayKind.value === null ? 0 : OVERLAY_GAP[overlayKind.value]
  const sideways = edge === 'left' || edge === 'right'
  const across = `${VETA_ISLAND.thickness}px`
  const style: CSSProperties = {
    paddingTop: edge === 'top' ? `${gap}px` : '0',
    paddingBottom: edge === 'bottom' ? `${gap}px` : `${SHADOW}px`,
    paddingLeft: edge === 'left' ? `${gap}px` : '0',
    paddingRight: edge === 'right' ? `${gap}px` : `${SHADOW}px`,
    visibility: overlay.shown.value ? 'visible' : 'hidden'
  }
  if (sideways) {
    style[edge] = across
    style[end === 'end' ? 'bottom' : 'top'] = '0'
  } else {
    style[edge] = across
    style[end === 'end' ? 'right' : 'left'] = '0'
  }
  return style
})

/** The overlay box's size, its gap and shadow room included: the room UI main grows the window by. */
function overlaySize(): { width: number; height: number } {
  const box = overlayBox.value
  return { width: box?.offsetWidth ?? 0, height: box?.offsetHeight ?? 0 }
}

watch(overlayKind, async (kind) => {
  if (kind === null) {
    await overlay.close()
    return
  }
  // The grip menu or the picker opened from the keyboard is a move outside the risen window too: it folds (S24.08).
  if (risenOpen.value) void risen.dispatch({ type: 'outside' })
  // Drawn hidden first, so it can be measured; shown once the window has its room (ADR-025 item 2).
  await nextTick()
  await overlay.open(overlaySize())
  if (overlayKind.value !== kind || !overlay.shown.value) return
  await nextTick()
  if (kind === 'menu') menuRef.value?.focusFirst()
  else pickerRef.value?.focusSearch()
})

/*
 * The worktree question over the picker (US-MINES-004.AC03, AC07; the Mines page's own WorktreeDialog): a dialog over
 * the whole window, so the window first grows to hold it (its card is at most 380 px wide, on 16 px of scrim each
 * side), and goes back to the picker's room once it has left.
 */
const QUESTION_ROOM = { width: 412, height: 280 } as const
const question = ref<MineWorktreeOf | null>(null)
watch(
  () => picker.worktree.value,
  async (asked) => {
    if (asked === null) {
      question.value = null
      await nextTick()
      if (overlayKind.value !== null) await overlay.open(overlaySize())
      return
    }
    const room = overlaySize()
    await overlay.open({
      width: Math.max(room.width, QUESTION_ROOM.width),
      height: Math.max(room.height, QUESTION_ROOM.height)
    })
    if (picker.worktree.value === asked) question.value = asked
  }
)

/** The Host-state message shows in this window (ISSUE-296): it holds the window, as the worktree question does. */
const hostStateShown = ref(false)

// While shown, a change of the overlay's size (a refusal line, a search) re-sizes its room.
let resizes: ResizeObserver | null = null
watch(overlayBox, (box) => {
  resizes?.disconnect()
  resizes = null
  if (box === null || typeof ResizeObserver === 'undefined') return
  resizes = new ResizeObserver(() => {
    if (overlay.shown.value && picker.worktree.value === null) void overlay.open(overlaySize())
  })
  resizes.observe(box)
})

// A drag closes an open overlay silently (S22.17) and a risen tab (S23.08): the window is the drag surface now, so no
// room is given back, and UI main forgot the tab band with it (it is asked again once the island has landed).
watch(dragging, (now) => {
  if (!now) return
  swallow = false
  tabStep({ type: 'drag-start' })
  void risen.dispatch({ type: 'interrupt', why: 'drag' })
  overlay.drop()
  if (overlayKind.value === null) return
  picker.dispatch({ type: 'interrupt' })
})

function chooseItem(id: GripMenuItemId): void {
  picker.dispatch({ type: 'choose', item: id })
}

/** A press anywhere: outside the open overlay it closes it (S22.03, S22.16). */
function pressed(event: PointerEvent): void {
  swallow = false
  // The Host-state message holds the window: a press on it folds nothing behind it (ISSUE-296).
  if (hostStateShown.value) return
  const target = event.target as Element | null
  // Outside the risen window, the strip included (S24.08); a press on a dwarf is its click's (S24.05).
  if (
    risenOpen.value &&
    target?.closest('[data-veta-risen]') == null &&
    target?.closest('[data-veta-dwarf]') == null &&
    target?.closest('[data-veta-more-item]') == null
  ) {
    void risen.dispatch({ type: 'outside' })
  }
  if (overlayKind.value === null) return
  if (target?.closest('[data-veta-overlay-card]')) return
  const step = picker.dispatch({ type: 'dismiss' })
  // The press that closed it on the grip or the entrance does not open it again when released.
  swallow = step.ok && target?.closest('[data-veta-grip], [data-veta-entrance]') != null
}

/** Clicking another app's window takes the focus away: an open menu or picker closes (S22.03, S22.16). */
function blurred(): void {
  if (overlayKind.value !== null) picker.dispatch({ type: 'dismiss' })
}

/*
 * Click-through (ADR-025 item 4): over the overlay's transparent room the mouse goes through to whatever is below.
 * The island and the overlay card take it; out of an overlay, and while dragged, the window is all island.
 */
const clickThrough = useWindowVetaClickThrough((x, y) => {
  if (dragging.value || question.value !== null || hostStateShown.value) return true
  return vetaTakesPointer(document.elementFromPoint?.(x, y) ?? null)
})

/*
 * The mine tab (07 machine 23): which chamber the pointer and the keyboard focus are on, the one tab risen, and the
 * effects its steps name.
 */
const tab = shallowRef<MineTab>(PLAIN_MINE_TAB)
const pointerOn = ref<MineId | null>(null)
const focusOn = ref<MineId | null>(null)
const drawn = computed(() => drawnChambers.value.map((c) => c.mine.id))

function tabStep(event: MineTabEvent): void {
  const next = stepMineTab(tab.value, event, {
    life: state.value,
    dragging: dragging.value,
    drawn: drawn.value
  })
  tab.value = next.machine
  if (!next.step.ok) return
  for (const effect of next.step.effects) {
    if (effect.kind === 'move') {
      life.openPanel(effect.mineId)
    } else {
      addFrom = 'tab'
      void risen.dispatch({ type: 'add', mineId: effect.mineId })
    }
  }
}

watch(
  () => aimOf(pointerOn.value, focusOn.value),
  (mineId) => tabStep({ type: 'aim', mineId })
)
// A chamber closed, folded into "+N" or its mine removed: its tab goes with it (S23.07).
watch(drawn, (now) => {
  if (pointerOn.value !== null && !now.includes(pointerOn.value)) pointerOn.value = null
  if (focusOn.value !== null && !now.includes(focusOn.value)) focusOn.value = null
  tabStep({ type: 'drawn' })
})

function chamberHover(mineId: MineId, on: boolean): void {
  if (on) pointerOn.value = mineId
  else if (pointerOn.value === mineId) pointerOn.value = null
}

function chamberFocus(mineId: MineId, on: boolean): void {
  if (on) focusOn.value = mineId
  else if (focusOn.value === mineId) focusOn.value = null
}

/** "▢" or "+" on a chamber's tab: only the risen one acts. */
function tabAction(mineId: MineId, type: 'open' | 'add'): void {
  if (tab.value.mineId === mineId) tabStep({ type })
}

/** Where a chamber's tab rises: toward the screen, away from the docked edge. */
const TAB_SIDE = { bottom: 'top', top: 'bottom', left: 'right', right: 'left' } as const
const tabSide = computed(() => TAB_SIDE[dock.dock.value.edge])

/*
 * The tab band (07 §24 I-22): the room every tab would rise into, measured from the tabs' boxes at their risen place
 * (offsets leave out their resting 4 px slide), held in the window while chambers are drawn. Measured again whenever
 * the strip's parts, its edge or its anchored end change, and once the island has landed after a drag.
 */
function measureBand(): Promise<void> {
  // A dragged island, or one whose strip is moving (machine 26): the band is measured once it has landed.
  if (dragging.value || choreo.moving.value) return Promise.resolve()
  const island = root.value?.querySelector<HTMLElement>('[data-veta-island]')
  if (island == null || !sessions.value) return overlay.band(null)
  const tabs: TabBox[] = [...island.querySelectorAll<HTMLElement>('[data-veta-tab]')].map((box) => {
    const chamber = box.parentElement!
    return {
      x: chamber.offsetLeft + box.offsetLeft,
      y: chamber.offsetTop + box.offsetTop,
      width: box.offsetWidth,
      height: box.offsetHeight
    }
  })
  const size = { width: island.offsetWidth, height: island.offsetHeight }
  // The "+N" list's room too, held beforehand so its hover never resizes the window (ISSUE-291).
  const list = island.querySelector<HTMLElement>('[data-veta-more-list]')
  const more = list === null ? [] : [boxIn(island, list)]
  return overlay.band(tabBand(dock.dock.value, size, [...tabs, ...labelBoxes(island), ...more]))
}

/** An element's box in the island's CSS pixels, from its top-left corner. */
function boxIn(island: HTMLElement, el: Element): TabBox {
  const origin = island.getBoundingClientRect()
  const box = el.getBoundingClientRect()
  return {
    x: box.left - origin.left,
    y: box.top - origin.top,
    width: box.width,
    height: box.height
  }
}

/** The hover-label probe: a label never shown, which measures each dwarf's label at its longest. */
const labelProbe = ref<InstanceType<typeof DwarfLabel> | null>(null)
/** A silence written with its most characters ("59m"), so a label never outgrows the room measured for it. */
const LONGEST_SILENCE = 59 * 60_000

/*
 * The room of every dwarf's hover label (ISSUE-290; S24.19), held in the band with the tabs' (07 §24 I-22), so a hover
 * never resizes the window: a window resized under the pointer moves the page under it, and the label would leave with
 * the hover it shows for. Each label is measured at its longest and placed where `labelPlace` puts it.
 */
function labelBoxes(island: HTMLElement): TabBox[] {
  const probe = labelProbe.value?.$el as HTMLElement | undefined
  if (probe === undefined) return []
  const inIsland = (el: Element): TabBox => boxIn(island, el)
  const boxes: TabBox[] = []
  for (const chamber of island.querySelectorAll<HTMLElement>('[data-veta-chamber]')) {
    const view = drawnChambers.value.find((c) => c.mine.id === chamber.dataset.mineId)
    if (view === undefined) continue
    const tab = chamber.querySelector<HTMLElement>('[data-veta-tab]')
    const tabBox =
      tab === null
        ? null
        : {
            x: chamber.offsetLeft + tab.offsetLeft,
            y: chamber.offsetTop + tab.offsetTop,
            width: tab.offsetWidth,
            height: tab.offsetHeight
          }
    for (const button of chamber.querySelectorAll<HTMLElement>('[data-veta-dwarf]')) {
      const dwarf = view.dwarfs.find((d) => d.id === button.dataset.dwarfId)
      if (dwarf === undefined) continue
      probe.textContent = dwarfLabels(dwarf, LONGEST_SILENCE).tip
      const measured = { width: probe.offsetWidth, height: probe.offsetHeight }
      boxes.push(labelBox(tabSide.value, inIsland(chamber), inIsland(button), tabBox, measured))
    }
  }
  probe.textContent = ''
  return boxes
}

watch(
  () => [
    sessions.value,
    dragging.value,
    choreo.moving.value,
    dock.dock.value.edge,
    dock.dock.value.end,
    folded.value
      .map((c) => `${c.mine.id}:${c.mine.name}:${c.attention}:${c.dwarfs.length}`)
      .join('|'),
    drawnChambers.value
      .map(
        (c) =>
          `${c.mine.id}:${c.mine.name}:${c.mine.tier ?? ''}:` +
          c.dwarfs.map((d) => `${d.customName ?? d.baseName}/${d.status}`).join(',')
      )
      .join('|')
  ],
  measureBand,
  { flush: 'post' }
)

function hovered(event: PointerEvent): void {
  clickThrough.pointerMoved(event.clientX, event.clientY)
}

/** Hidden mid-drag (S21.10, S10.08): the island goes back where it was; an open overlay closes (S22.17). */
function visibility(): void {
  // Shown: the fit is measured on each show (S25.01, S25.02).
  if (document.visibilityState !== 'hidden') {
    overflow.remeasure()
    return
  }
  dock.cancel('hidden')
  picker.dispatch({ type: 'interrupt' })
  void risen.dispatch({ type: 'interrupt', why: 'hidden' })
}

/*
 * Machine 26's motion (ISSUE-292; `DS/docs/motion.md`, "Veta, no sessions → working", "Veta, a dwarf arrives or
 * leaves"), played on the island's own elements by the bounded runner: transform and opacity only, every entry eased
 * out and every exit eased in, each resolving on its end or its watchdog at its duration + 40 ms. "Beyond" is further
 * from the anchor than a chamber; what lies there slides by FLIP when the chamber opens, widens, narrows or closes.
 */
const motion = createVetaMotion({
  onHidden(listener) {
    document.addEventListener('visibilitychange', listener)
    return () => document.removeEventListener('visibilitychange', listener)
  }
})

/** The island's parts from the anchor outward: expand, the chambers, "+N", the grip. */
function partsFromAnchor(): HTMLElement[] {
  const island = root.value?.querySelector<HTMLElement>('[data-veta-island]')
  if (island == null) return []
  const parts = [
    ...island.querySelectorAll<HTMLElement>('[data-veta-part]:not([data-veta-part="entrance"])')
  ]
  return anchorEnd.value ? parts.reverse() : parts
}

const chamberEl = (mineId: string): HTMLElement | null =>
  root.value?.querySelector<HTMLElement>(`[data-veta-chamber][data-mine-id="${mineId}"]`) ?? null
const dwarfEl = (dwarfId: string): HTMLElement | null =>
  root.value?.querySelector<HTMLElement>(`[data-veta-dwarf][data-dwarf-id="${dwarfId}"]`) ?? null

/** Where every part stands now, for a FLIP after the strip changes. */
function measureParts(): Map<HTMLElement, DOMRect> {
  return new Map(partsFromAnchor().map((part) => [part, part.getBoundingClientRect()]))
}

/** FLIP: each part that moved plays from where it was to where it is (translate only); `keep` stays put. */
function slide(
  before: Map<HTMLElement, DOMRect>,
  keep: readonly (Element | null)[]
): Promise<void>[] {
  const runs: Promise<void>[] = []
  for (const part of partsFromAnchor()) {
    const was = before.get(part)
    if (was === undefined || keep.includes(part)) continue
    const now = part.getBoundingClientRect()
    const dx = was.left - now.left
    const dy = was.top - now.top
    if ((dx === 0 && dy === 0) || now.width === 0) continue
    runs.push(
      motion.run(part, flipFrames(dx, dy), {
        duration: VETA_MOTION.flipMs,
        easing: VETA_MOTION.easeOut,
        fill: 'backwards'
      })
    )
  }
  return runs
}

/** The walkers' buttons, each with its place among its chamber's walkers: 70 ms apart within a chamber. */
function walkersOf(dwarfIds: readonly string[]): Array<{ button: HTMLElement; at: number }> {
  const seen = new Map<Element | null, number>()
  const walkers: Array<{ button: HTMLElement; at: number }> = []
  for (const id of dwarfIds) {
    const button = dwarfEl(id)
    if (button === null) continue
    const chamber = button.closest('[data-veta-chamber]')
    const at = seen.get(chamber) ?? 0
    seen.set(chamber, at + 1)
    walkers.push({ button, at })
  }
  return walkers
}

async function play(cue: VetaCue): Promise<void> {
  const m = VETA_MOTION
  const away = outwardOf(vertical.value, anchorEnd.value)
  const entry = { easing: m.easeOut, fill: 'backwards' } as const
  const exit = { easing: m.easeIn, fill: 'forwards' } as const
  switch (cue.kind) {
    case 'build': {
      cue.mutate?.()
      await nextTick()
      await Promise.all(
        partsFromAnchor().map((part, i) =>
          motion.run(part, partFrames(away), {
            ...entry,
            duration: m.part.ms,
            delay: i * m.part.staggerMs
          })
        )
      )
      return
    }
    case 'open-chamber': {
      const before = measureParts()
      cue.mutate?.()
      await nextTick()
      const opened = chamberEl(cue.mineId)
      await Promise.all([
        ...slide(before, [opened]),
        opened === null
          ? Promise.resolve()
          : motion.run(opened, chamberOpenFrames(away), { ...entry, duration: m.chamberOpen.ms })
      ])
      return
    }
    case 'walk-in': {
      const before = measureParts()
      cue.mutate?.()
      await nextTick()
      // Only the dwarf walks in: its own chamber stays where it is; what lies beyond a widened one slides.
      await Promise.all([
        ...slide(before, [chamberEl(cue.mineId)]),
        ...walkersOf(cue.dwarfIds).map(({ button, at }) =>
          motion.run(button, walkInFrames(away), {
            ...entry,
            duration: m.walkIn.ms,
            delay: at * m.walkIn.staggerMs
          })
        )
      ])
      return
    }
    case 'walk-out': {
      cue.mutate?.()
      await nextTick()
      const button = dwarfEl(cue.dwarfId)
      if (button !== null) {
        await motion.run(button, walkOutFrames(away), { ...exit, duration: m.walkOut.ms })
      }
      return
    }
    case 'close-chamber': {
      const closing = chamberEl(cue.mineId)
      if (closing !== null) {
        await motion.run(closing, fadeOutFrames(), { ...exit, duration: m.chamberClose.ms })
      }
      if (!cue.slideBack) {
        cue.mutate?.()
        return
      }
      const before = measureParts()
      cue.mutate?.()
      await nextTick()
      await Promise.all(slide(before, []))
      return
    }
    case 'slide-back': {
      const before = measureParts()
      cue.mutate?.()
      await nextTick()
      await Promise.all(slide(before, [chamberEl(cue.mineId)]))
      return
    }
    case 'contract': {
      cue.mutate?.()
      await nextTick()
      const entrance = root.value?.querySelector<HTMLElement>('[data-veta-entrance]') ?? null
      if (entrance !== null) {
        await motion.run(entrance, enterFrames(), { ...entry, duration: m.contract.ms })
      }
      return
    }
  }
}

/** Ends the motion on these dwarfs' buttons, or every motion in the window (S26.12, S26.13, S26.14). */
function cancelMotion(dwarfIds?: readonly string[]): void {
  if (dwarfIds === undefined) motion.cancel()
  else motion.cancel(dwarfIds.map(dwarfEl).filter((b): b is HTMLElement => b !== null))
}

/*
 * The risen window (07 machine 24; ISSUE-290). The Panel's own conversation and launch, over this window's own board,
 * feed the hosted panels (BR-21); this window measures where the risen window stands and plays its motion.
 */
const board = useMines()
const chat = useMessageDock()
const { chatFeedOf } = useDwarfMessaging()
const risenRef = ref<InstanceType<typeof VetaRisen> | null>(null)

const sideways = (): boolean => dock.dock.value.edge === 'left' || dock.dock.value.edge === 'right'

/** A box's centre along the island, from the island's start. */
function centreAlong(island: DOMRect, box: DOMRect): number {
  return sideways() ? box.top + box.height / 2 - island.top : box.left + box.width / 2 - island.left
}

/** The work area of the display (the stage) and the island on it, along its edge, in CSS pixels. */
function measureStage(): {
  size: { width: number; height: number }
  island: { length: number; thickness: number; before: number; after: number }
} {
  const screen = window.screen as Screen & { availLeft?: number; availTop?: number }
  const size = { width: screen.availWidth, height: screen.availHeight }
  const island = root.value
    ?.querySelector<HTMLElement>('[data-veta-island]')
    ?.getBoundingClientRect()
  const side = sideways()
  const length = island === undefined ? 0 : side ? island.height : island.width
  const at =
    island === undefined
      ? 0
      : side
        ? window.screenY + island.top - (screen.availTop ?? 0)
        : window.screenX + island.left - (screen.availLeft ?? 0)
  const stageLength = side ? size.height : size.width
  return {
    size,
    island: {
      length,
      thickness: VETA_ISLAND.thickness,
      before: at,
      after: stageLength - at - length
    }
  }
}

/** The centre of what opened the risen window: the dwarf, the mine tab's "+", or the grip or the entrance. */
function anchorOf(content: RisenContent): number {
  const island = root.value?.querySelector<HTMLElement>('[data-veta-island]')
  if (island == null) return 0
  const islandBox = island.getBoundingClientRect()
  const selector =
    content.kind === 'chat'
      ? `[data-veta-dwarf][data-dwarf-id="${content.dwarfId}"]`
      : addFrom === 'tab'
        ? `[data-veta-chamber][data-mine-id="${content.mineId}"] [data-tab-add]`
        : '[data-veta-grip], [data-veta-entrance]'
  const target = island.querySelector<HTMLElement>(selector)
  if (target === null) return (sideways() ? islandBox.height : islandBox.width) / 2
  return centreAlong(islandBox, target.getBoundingClientRect())
}

const risen = useWindowVetaRisen({
  dock: () => dock.dock.value,
  stage: measureStage,
  anchor: anchorOf,
  addRoom: (size) => overlay.hold(size),
  capture: (dwarfId) =>
    risenRef.value === null
      ? null
      : { draft: chat.drafts.value[dwarfId] ?? '', view: risenRef.value.captureView() },
  async showChat(mineId, dwarfId, draft, view) {
    chat.setDraft(dwarfId, draft)
    chat.openMessage(mineId, dwarfId)
    await nextTick()
    await risenRef.value?.restoreView(view)
  },
  showAdd: (mineId) => chat.openLaunch(mineId),
  dropDraft: (dwarfId) => chat.setDraft(dwarfId, ''),
  clear: () => chat.close(),
  motion: (kind) => risenRef.value?.play(kind) ?? Promise.resolve(),
  focus: (target) => risenRef.value?.focusContent(target),
  present: (mineId, dwarfId) =>
    chambers.value.some((c) => c.mine.id === mineId && c.dwarfs.some((d) => d.id === dwarfId)),
  // A folded mine's chamber was unfolded before the reveal stepped (S25.08): it is in view already.
  bringMine: () => undefined,
  unfold: (mineId) => overflow.reveal(mineId),
  dragging: () => dragging.value,
  unhovered: whenUnhovered
})

// A re-snapshot (the Host back, `events_lost`, a new Host epoch) closes a risen chat whose dwarf it lacks (S20.16).
const stopResnapshot = life.onFacts((facts) => {
  if (facts.some((fact) => fact.kind === 'snapshot')) void risen.resnapshot()
})

/*
 * The Host-state message's room (ISSUE-296; DR-03): the risen window's, centred on the island (07 machine 24's
 * geometry), held as an overlay's beside the band. An open menu or picker closes first: one thing holds the window.
 */
async function hostStateRoom(open: boolean): Promise<void> {
  if (!open) {
    await overlay.close()
    return
  }
  if (overlayKind.value !== null) {
    picker.dispatch({ type: 'interrupt' })
    await nextTick()
  }
  const { size, island } = measureStage()
  await overlay.open(risenGeometry(dock.dock.value, size, island, island.length / 2).room)
}

/** Stops hearing runs into Veta that carry a chat (S24.18). */
let stopLanding: (() => void) | null = null
/** Stops hearing the runs Veta leaves (S24.14). */
let stopLeaving: (() => void) | null = null

const risenOpen = computed(() => {
  const now = risen.machine.value.state
  return now === 'risen-chat' || now === 'risen-add' || now === 'read-only'
})

/*
 * A click on a "+N" list item (S25.11; OQ-76 A): its chamber unfolds after the window grew, then the chat of the mine's
 * dwarf that needs the person, oldest first, else of the one last talked to there, else of the first of its crew,
 * opens as for a reveal (S24.15), or replaces the one risen (S24.05); with no dwarf present only its chamber shows.
 */
async function pickFolded(mineId: MineId): Promise<void> {
  if (!(await overflow.pick(mineId))) return
  const crew = chambers.value.find((c) => c.mine.id === mineId)?.dwarfs ?? []
  const talkedTo = await risen.talkedTo(
    mineId,
    crew.map((d) => d.id)
  )
  const dwarfId = dwarfToOpen(crew, talkedTo)
  const { content } = risen.machine.value
  if (!risenOpen.value) {
    void risen.dispatch({ type: 'reveal', mineId, dwarfId, present: dwarfId !== null })
  } else if (dwarfId === null) {
    void risen.dispatch({ type: 'outside' })
  } else if (content?.kind !== 'chat' || content.dwarfId !== dwarfId) {
    void risen.dispatch({ type: 'dwarf-hit', dwarfId, mineId })
  }
}
/** The mine the risen Add panel is aimed at. */
const addPanelFor = computed<MineId | null>(() => {
  const { state: now, content } = risen.machine.value
  return content?.kind === 'add' && now !== 'folding' ? content.mineId : null
})
const addMineName = computed(
  () => life.mines.value.find((m) => m.mine.id === addPanelFor.value)?.mine.name ?? ''
)
/** The dwarf whose chat is risen, drawn pressed in its chamber. */
const openDwarf = computed<DwarfId | null>(() => {
  const { state: now, content } = risen.machine.value
  return content?.kind === 'chat' && now !== 'folding' ? content.dwarfId : null
})

function dwarfHit(mineId: MineId, dwarfId: DwarfId): void {
  void risen.dispatch({ type: 'dwarf-hit', dwarfId, mineId })
}

/** The chat's draft as it is typed: held by the hosted dock, and kept in the session store. */
function risenDraft(dwarfId: string, text: string): void {
  chat.setDraft(dwarfId, text)
  risen.draft(dwarfId as DwarfId, text)
}

/** Esc outside the risen window folds it (S24.08); inside it the panel's own Esc closes it, the rename's first. */
function escape(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !risenOpen.value || hostStateShown.value) return
  const target = event.target as Element | null
  if (typeof target?.closest === 'function' && target.closest('[data-veta-risen]') !== null) return
  void risen.dispatch({ type: 'esc', renaming: false })
}

// The launch sent from the risen Add panel: its dwarf, or its failure shown inside it (S24.06, S24.07).
watch(
  () => chat.launch.state.value.launchedDwarfId,
  (dwarfId) => {
    if (dwarfId !== null && risen.machine.value.state === 'risen-add') {
      void risen.dispatch({ type: 'launched', dwarfId: dwarfId as DwarfId })
    }
  }
)
watch(
  () => chat.launch.state.value.failure,
  (failure) => {
    if (failure != null) void risen.dispatch({ type: 'launch-failed' })
  }
)
// The Add panel's mine removed: it closes outright (S24.11).
watch(
  () => life.mines.value.map((m) => m.mine.id),
  (live) => {
    const aimed = addPanelFor.value
    if (aimed !== null && !live.includes(aimed)) {
      void risen.dispatch({ type: 'mine-removed', mineId: aimed })
    }
  }
)

/*
 * A dwarf's hover label (S24.19): its silence counted a second at a time while one is hovered, from its newest message
 * in this window's chat feed; shown once the window holds its room.
 */
const hoveredDwarf = ref<DwarfId | null>(null)
const labelOn = ref(false)
const now = ref(Date.now())
let ticking: ReturnType<typeof setInterval> | null = null

function stopTicking(): void {
  if (ticking !== null) clearInterval(ticking)
  ticking = null
}

function labelsOf(dwarf: DwarfWire): { tip: string; aria: string } {
  return dwarfLabels(dwarf, silenceOf(chatFeedOf(dwarf.id)?.messages, now.value))
}

function dwarfHover(dwarfId: DwarfId | null): void {
  hoveredDwarf.value = dwarfId
  if (dwarfId === null) {
    stopTicking()
    return
  }
  now.value = Date.now()
  ticking ??= setInterval(() => {
    now.value = Date.now()
  }, 1_000)
}

// Drawn first at opacity 0, then shown, so it fades in (`.dm-chamber__label`, 90 ms).
watch(hoveredDwarf, async (dwarfId) => {
  labelOn.value = false
  if (dwarfId === null) return
  await nextTick()
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  labelOn.value = hoveredDwarf.value === dwarfId
})

// A new length re-places the window for it (S21.19); the first is sent by the dock's start, and a growth asked for
// before it was drawn has placed it already.
watch(length, (now) => {
  // Machine 26 resizes the window itself: before a growth, and after the motion (ADR-025 item 2).
  if (choreo.moving.value) return
  const already = grown === now
  grown = null
  if (!started || already) return
  // A shorter island (a re-snapshot that lacks a dwarf, ISSUE-296) waits for the hover gate; a longer one is placed now.
  if (placed !== null && now < placed) void placeAfterMotion()
  else void placeIsland()
})

// The fit is measured again on an edge or display change (S21.09, S21.11, S21.12, S25.03).
watch(
  () => [dock.dock.value.edge, dock.displayKey.value],
  () => overflow.remeasure()
)

/** A window resize re-measures the fit (S25.03). */
function resized(): void {
  overflow.remeasure()
}

onMounted(() => {
  document.addEventListener('visibilitychange', visibility)
  document.addEventListener('pointerdown', pressed, true)
  window.addEventListener('blur', blurred)
  void dock.start().then(() => {
    started = true
  })
  // A name measures its true width once the pixel faces have loaded.
  void document.fonts?.ready.then(measureBand)
  void life.start()
  void board.start()
  risen.start()
  // S24.18 (ISSUE-293): a run into Veta carrying a chat rises it once the shell motion landed, as a click does.
  stopLanding = modeTransitionPart().onLanded((carried) => {
    void risen.dispatch({
      type: 'arrive',
      mineId: carried.mineId,
      dwarfId: carried.dwarfId,
      present: chambers.value.some(
        (c) => c.mine.id === carried.mineId && c.dwarfs.some((d) => d.id === carried.dwarfId)
      )
    })
  })
  // S24.14 (ISSUE-293): once Veta played its half of a run away, its content veiled, the risen chat folds at once, its
  // draft and view kept. A hidden frameless window does not reliably report itself hidden (`visibilitychange`).
  stopLeaving = modeTransitionPart().onLeft(() => {
    void risen.dispatch({ type: 'interrupt', why: 'hidden' })
  })
  document.addEventListener('keydown', escape)
  window.addEventListener('resize', resized)
})
onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', visibility)
  document.removeEventListener('pointerdown', pressed, true)
  window.removeEventListener('blur', blurred)
  resizes?.disconnect()
  dock.dispose()
  life.stop()
  stopResnapshot()
  risen.stop()
  stopLanding?.()
  stopLeaving?.()
  choreo.stop()
  motion.dispose()
  board.stop()
  document.removeEventListener('keydown', escape)
  window.removeEventListener('resize', resized)
  overflow.stop()
  stopTicking()
})
</script>

<template>
  <div
    ref="root"
    class="veta-root"
    data-veta-root
    :data-edge="dock.dock.value.edge"
    :data-life="state ?? 'unknown'"
    :data-held="life.held.value ? 'true' : undefined"
    :data-add-panel-for="addPanelFor ?? undefined"
    @pointermove="hovered"
  >
    <div
      v-if="preview !== null"
      class="veta-snap"
      :data-edge="preview"
      :style="snapStyle"
      aria-hidden="true"
      data-veta-snap
    />
    <VetaIsland
      class="veta-root__island"
      :mode="closed ? (state === 'first-run' ? 'first' : 'empty') : sessions ? 'sessions' : null"
      :vertical="vertical"
      :dragging="dragging"
      :style="islandStyle"
      @wheel="wheeled"
    >
      <VetaEntrance
        v-if="closed"
        :first="state === 'first-run'"
        :vertical="vertical"
        :lit="choreo.lit.value"
        @activate="enter"
      />
      <template v-else-if="sessions">
        <VetaExpand v-if="!anchorEnd" :edge="dock.dock.value.edge" @activate="life.openPanel()" />
        <VetaGrip
          v-if="anchorEnd"
          :vertical="vertical"
          :expanded="overlayKind === 'menu'"
          data-veta-part="grip"
          @press="dock.pointerDown(facts($event))"
          @move="move"
          @release="dock.pointerUp(facts($event))"
          @cancel="dock.cancel($event)"
          @key="key"
          @menu="gripMenu"
        />
        <VetaOverflow
          v-if="anchorEnd && folded.length > 0"
          :folded="folded"
          :shown="listShown"
          :edge="dock.dock.value.edge"
          :side="tabSide"
          @enter="overflow.enter()"
          @leave="overflow.leave()"
          @pick="pickFolded"
        />
        <VetaChamber
          v-for="chamber in ordered"
          :key="chamber.mine.id"
          :mine="chamber.mine"
          :dwarfs="chamber.dwarfs"
          :attention="chamber.attention"
          :vertical="vertical"
          :reverse="anchorEnd"
          :side="tabSide"
          :risen="tab.state === 'risen' && tab.mineId === chamber.mine.id"
          :open-dwarf="openDwarf"
          :labels-of="labelsOf"
          :label-on="labelOn"
          :pointer-dwarf="pointerDwarf"
          :walking="choreo.walking.value"
          :arrived="choreo.arrived.value"
          @dwarf="dwarfHit(chamber.mine.id, $event)"
          @dwarf-hover="dwarfHover"
          @hover="chamberHover(chamber.mine.id, $event)"
          @focus="chamberFocus(chamber.mine.id, $event)"
          @open="tabAction(chamber.mine.id, 'open')"
          @add="tabAction(chamber.mine.id, 'add')"
        />
        <VetaOverflow
          v-if="!anchorEnd && folded.length > 0"
          :folded="folded"
          :shown="listShown"
          :edge="dock.dock.value.edge"
          :side="tabSide"
          @enter="overflow.enter()"
          @leave="overflow.leave()"
          @pick="pickFolded"
        />
        <VetaExpand v-if="anchorEnd" :edge="dock.dock.value.edge" @activate="life.openPanel()" />
        <VetaGrip
          v-if="!anchorEnd"
          :vertical="vertical"
          :expanded="overlayKind === 'menu'"
          data-veta-part="grip"
          @press="dock.pointerDown(facts($event))"
          @move="move"
          @release="dock.pointerUp(facts($event))"
          @cancel="dock.cancel($event)"
          @key="key"
          @menu="gripMenu"
        />
      </template>
    </VetaIsland>
    <div
      v-if="overlayKind !== null"
      ref="overlayBox"
      class="veta-overlay"
      :style="overlayStyle"
      :data-shown="overlay.shown.value ? 'true' : 'false'"
      data-veta-overlay
    >
      <div class="veta-overlay__card" data-veta-overlay-card>
        <VetaGripMenu
          v-if="overlayKind === 'menu'"
          ref="menuRef"
          :entries="menuEntries"
          @choose="chooseItem"
          @close="picker.dispatch({ type: 'dismiss' })"
        />
        <MinePicker
          v-else
          ref="pickerRef"
          :rows="picker.rows.value"
          :notice="picker.notice.value"
          @pick="picker.dispatch({ type: 'pick-mine', mineId: $event, enterable: true })"
          @add="picker.dispatch({ type: 'add-mine' })"
          @close="picker.dispatch({ type: 'dismiss' })"
          @filter="picker.dispatch({ type: 'filter' })"
        />
      </div>
    </div>
    <DwarfLabel
      ref="labelProbe"
      class="veta-root__probe"
      text=""
      side="top"
      :place="{}"
      :on="false"
    />
    <VetaRisen
      ref="risenRef"
      :machine="risen.machine.value"
      :geometry="risen.geometry.value"
      :edge="dock.dock.value.edge"
      :end="dock.dock.value.end"
      :thickness="VETA_ISLAND.thickness"
      :dock="chat"
      :add-mine-name="addMineName"
      @draft="risenDraft"
      @close="risen.dispatch({ type: 'esc', renaming: false })"
      @open-in-panel="risen.dispatch({ type: 'open-in-panel' })"
    />
    <!-- An incompatible Host's Stop everything and quit goes to the Panel, which holds its confirmation (ISSUE-296). -->
    <VetaHostState
      :room="hostStateRoom"
      :on-stop-everything="() => life.openPanel()"
      @shown="hostStateShown = $event"
    />
    <WorktreeDialog
      :question="question"
      :adding="picker.adopting.value"
      @accept="picker.answerWorktree(true)"
      @dismiss="picker.answerWorktree(false)"
    />
  </div>
</template>

<style scoped>
.veta-root {
  position: relative;
  height: 100%;
  background: transparent;
  overflow: hidden;
}

/* The island keeps to its edge and anchored end (inline), so a window grown for an overlay never moves it. */
.veta-root__island {
  position: absolute;
}

/* The hover-label probe: laid out to be measured, never seen. */
.veta-root__probe {
  visibility: hidden;
}

/* The overlay's room beside the island: transparent, its card drawn at the island's anchored end. */
.veta-overlay {
  position: absolute;
  display: flex;
  box-sizing: border-box;
  z-index: 6;
}

.veta-overlay__card {
  display: inline-block;
}

/* `.dm-veta-snap`: the island where it would land, a dashed brass outline over a hover wash. */
.veta-snap {
  position: absolute;
  left: 0;
  top: 0;
  z-index: 5;
  background: var(--hover-wash);
  outline: var(--px) dashed var(--brass);
  outline-offset: calc(var(--px) * -1);
  pointer-events: none;
}
</style>
