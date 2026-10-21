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
 * - `all-idle` and `sessions-working`: parts from the anchor outward, expand, one chamber per mine at work, the "+N"
 *   slot (ISSUE-291) and the grip. DOM order is visual order: anchored at the right or bottom end it runs grip, the
 *   chambers last-seen first, expand. Mines keep their first-seen order, so a lit chamber never jumps.
 * - Before the Host has answered, nothing is drawn.
 *
 * The window hugs the island: its length along the edge is reported to UI main (`layoutVeta {island-resize}`, A-N23)
 * each time it changes, its thickness is `VETA_ISLAND.thickness`. The drawn chambers are reported as the mines on
 * screen (A-44, S20.18).
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
import { useWindowVetaClickThrough, vetaTakesPointer } from '../../composables/useVetaClickThrough'
import { useWindowVetaDock } from '../../composables/useVetaDock'
import { useWindowVetaLife } from '../../composables/useVetaLife'
import { useWindowVetaOverlay } from '../../composables/useVetaOverlay'
import { useWindowVetaPresence } from '../../composables/useVetaPresence'
import { useWindowVetaRisen } from '../../composables/useVetaRisen'
import { SHIPPED_MODES } from '../../lib/shell/builtDestinations'
import { snapRect } from '../../lib/veta/dockGesture'
import { dwarfLabels, labelBox, silenceOf } from '../../lib/veta/dwarfLabel'
import { gripMenuEntries, type GripMenuItemId, type Opener } from '../../lib/veta/gripMenu'
import { islandLength } from '../../lib/veta/island'
import { entranceIntent } from '../../lib/veta/lifeState'
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
import DwarfLabel from './DwarfLabel.vue'
import VetaRisen from './VetaRisen.vue'
import type { RisenContent } from '../../lib/veta/risenWindow'

const life = useWindowVetaLife()
const { state, chambers } = life

const closed = computed(() => state.value === 'first-run' || state.value === 'no-sessions')
const sessions = computed(() => state.value === 'all-idle' || state.value === 'sessions-working')

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

// The dock reads the island's length only once mounted, after `length` below exists.
const dock = useWindowVetaDock(
  () => length.value,
  () => {
    if (swallow) swallow = false
    else picker.dispatch({ type: 'grip-click', dragging: false })
  }
)
const { vertical, dragging, preview, follow } = dock
/** The island's length along its edge: the closed entrance's, or the strip's parts added up. */
const length = computed(() =>
  sessions.value
    ? islandLength(
        { kind: 'chambers', crews: chambers.value.map((c) => c.dwarfs.length) },
        vertical.value
      )
    : VETA_ISLAND.length
)
const anchorEnd = computed(() => dock.dock.value.end === 'end')
const ordered = computed(() => (anchorEnd.value ? [...chambers.value].reverse() : chambers.value))

useWindowVetaPresence(() => ({
  state: state.value,
  shown: life.shown.value,
  drawn: chambers.value.map((c) => c.mine.id)
}))

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
  const target = event.target as Element | null
  // Outside the risen window, the strip included (S24.08); a press on a dwarf is its click's (S24.05).
  if (
    risenOpen.value &&
    target?.closest('[data-veta-risen]') == null &&
    target?.closest('[data-veta-dwarf]') == null
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
  if (dragging.value || question.value !== null) return true
  return vetaTakesPointer(document.elementFromPoint?.(x, y) ?? null)
})

/*
 * The mine tab (07 machine 23): which chamber the pointer and the keyboard focus are on, the one tab risen, and the
 * effects its steps name.
 */
const tab = shallowRef<MineTab>(PLAIN_MINE_TAB)
const pointerOn = ref<MineId | null>(null)
const focusOn = ref<MineId | null>(null)
const drawn = computed(() => chambers.value.map((c) => c.mine.id))

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
  if (dragging.value) return Promise.resolve()
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
  return overlay.band(tabBand(dock.dock.value, size, [...tabs, ...labelBoxes(island)]))
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
  const origin = island.getBoundingClientRect()
  const inIsland = (el: Element): TabBox => {
    const box = el.getBoundingClientRect()
    return {
      x: box.left - origin.left,
      y: box.top - origin.top,
      width: box.width,
      height: box.height
    }
  }
  const boxes: TabBox[] = []
  for (const chamber of island.querySelectorAll<HTMLElement>('[data-veta-chamber]')) {
    const view = chambers.value.find((c) => c.mine.id === chamber.dataset.mineId)
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
    dock.dock.value.edge,
    dock.dock.value.end,
    chambers.value
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
  if (document.visibilityState !== 'hidden') return
  dock.cancel('hidden')
  picker.dispatch({ type: 'interrupt' })
  void risen.dispatch({ type: 'interrupt', why: 'hidden' })
}

/*
 * The risen window (07 machine 24; ISSUE-290). The Panel's own conversation and launch, over this window's own board,
 * feed the hosted panels (BR-21); this window measures where the risen window stands and plays its motion.
 */
const board = useMines()
const chat = useMessageDock()
const { chatFeedOf } = useDwarfMessaging()
const risenRef = ref<InstanceType<typeof VetaRisen> | null>(null)
let unlistenWalks: (() => void) | null = null

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
  // Every mine at work has its chamber drawn until "+N" folds some (ISSUE-291, S25.08): nothing to bring into view.
  bringMine: () => undefined,
  dragging: () => dragging.value
})

const risenOpen = computed(() => {
  const now = risen.machine.value.state
  return now === 'risen-chat' || now === 'risen-add' || now === 'read-only'
})
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
  if (event.key !== 'Escape' || !risenOpen.value) return
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

let started = false
// A new length re-places the window for it (S21.19); the first is sent by the dock's start.
watch(length, () => {
  if (started) void dock.resized()
})

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
  unlistenWalks = board.onWalk((walk) => {
    if (walk.kind === 'walk-out') {
      void risen.dispatch({ type: 'departed', dwarfId: walk.dwarfId, cause: walk.cause })
    }
  })
  document.addEventListener('keydown', escape)
})
onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', visibility)
  document.removeEventListener('pointerdown', pressed, true)
  window.removeEventListener('blur', blurred)
  resizes?.disconnect()
  dock.dispose()
  life.stop()
  risen.stop()
  unlistenWalks?.()
  board.stop()
  document.removeEventListener('keydown', escape)
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
    >
      <VetaEntrance
        v-if="closed"
        :first="state === 'first-run'"
        :vertical="vertical"
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
          @dwarf="dwarfHit(chamber.mine.id, $event)"
          @dwarf-hover="dwarfHover"
          @hover="chamberHover(chamber.mine.id, $event)"
          @focus="chamberFocus(chamber.mine.id, $event)"
          @open="tabAction(chamber.mine.id, 'open')"
          @add="tabAction(chamber.mine.id, 'add')"
        />
        <!-- "+N" lands here, on the anchor side of the grip (ISSUE-291). -->
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
