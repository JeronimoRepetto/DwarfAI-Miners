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
 *   (the MessagePanel and the Add panel inside a pin) are hosted in the stack's and the deck's `chat` slot.
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
 *
 * The bridge is the composition root's (`valleBridgeOf(window.api)`, R13); the observer is the browser's own unless a
 * test hands one.
 */
import type { DwarfId, MineId } from '@dwarfai/contracts'
import { computed, nextTick, onMounted, onUnmounted, provide, shallowRef, watch } from 'vue'
import { useValleArrivalToast } from '../../composables/useValleArrivalToast'
import { useValleMosaic, type ValleZoneKey } from '../../composables/useValleMosaic'
import { useMapPage } from '../../composables/useMapPage'
import { useMines } from '../../composables/useMines'
import { useMinesPage } from '../../composables/useMinesPage'
import { useVallePins } from '../../composables/useVallePins'
import { useVallePreset } from '../../composables/useVallePreset'
import { useVallePresence, type VallePresenceDeps } from '../../composables/useVallePresence'
import {
  browserBodyObserver,
  useValleSplit,
  type ValleBodyObserver
} from '../../composables/useValleSplit'
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
import type { ValleFacts, ValleNavPage } from '../../lib/valle/preset'
import { createVetaMotion } from '../../lib/veta/vetaMotion'
import { createValleReadModel } from '../../lib/valle/valleReadModel'
import WorktreeDialog from '../browse/WorktreeDialog.vue'
import ToastHost from '../overlay/ToastHost.vue'
import ChatDeck from './ChatDeck.vue'
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
provide(VALLE_PAGES, { board: board.state, map: mapPage, mines: minesPage })
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
  // A hidden window freezes timelines: the run resolves at once (S28.22).
  if (!shown.value) preset.send({ kind: 'hidden' })
}
document.addEventListener('visibilitychange', visibilityChanged)

const presence = useVallePresence({
  bridge: props.bridge,
  // A nav page over the main zone hides every mine (S39.05; 07 §24 I-36).
  facts: () => ({ shown: shown.value, pageOverMain: view.value.page !== null }),
  observer:
    props.observer ??
    ((callback, options) =>
      new IntersectionObserver(
        (entries) =>
          callback(entries.map(({ target, intersectionRatio }) => ({ target, intersectionRatio }))),
        options
      ))
})
provide(VALLE_TRACK_ZONE, presence.track)

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
const pins = useVallePins({
  bridge: props.bridge,
  stores,
  model,
  factsRead,
  talkedLast: () => stores.value.session.panelOpenChat ?? null
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
  scrollTo: (mineId) => {
    void nextTick(() => {
      const column = room.value?.mosaic?.querySelector(`[data-valle-column="${mineId}"]`)
      if (column instanceof HTMLElement && typeof column.scrollIntoView === 'function')
        column.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    })
  }
})
const columns = computed(() =>
  mosaic.order.value.map((mineId) => ({
    mineId,
    name: nameOf(mineId),
    enterable: enterable(mineId),
    content: mosaic.contentOf(mineId)
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
const nameOf = (mineId: MineId): string =>
  model.mines.value.find((mine) => mine.id === mineId)?.name ?? ''
const listMines = computed(() =>
  model.mines.value.map((mine) => ({ mineId: mine.id, name: mine.name }))
)
const shownMine = computed(() => {
  const mineId = frontMine.value
  return mineId === null ? null : { mineId, name: nameOf(mineId) }
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

/** The chat in focus, carried by "▼ Panel" / "▼ Veta" (S28.21, machine 9): the focused chat pin's. */
const chat = computed((): { mineId: string; dwarfId: DwarfId } | null => {
  const set = pins.set.value
  const pin = set.pins.find((p) => p.key === set.focus)
  return pin?.kind === 'chat' ? { mineId: pin.mineId, dwarfId: pin.dwarfId } : null
})

/** Valle's nav column: the slots whose page takes the main zone (S28.19), the Panel's own slots. */
const NAV_SLOTS = [...WORLD_SLOTS, ...SYSTEM_SLOTS].filter(
  (slot): slot is PanelNavSlot & { area: ValleNavPage } =>
    slot.area === 'map' || slot.area === 'mines' || slot.area === 'settings'
)
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

/** A nav slot: its page over the main zone (S28.19); the Mines page reads the remembered projects again, as the Panel's. */
function nav(page: ValleNavPage): void {
  if (page === 'mines') void minesPage.load()
  preset.send({ kind: 'nav', page })
}

function onKey(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  // Esc closes the topmost layer first (NFR-A11Y-02): a menu that already took it, an open zone or slot menu, the
  // worktree question; then a page, then the Work front.
  if (event.defaultPrevented || mosaic.dismiss()) return
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
    if (fact.kind === 'mine-removed') preset.send({ kind: 'mine-removed', mineId: fact.mineId })
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
  })
  // The hosted pages' board and remembered projects (ISSUE-304).
  void board.start({ announce: false }).then(() => mapPage.loaded())
  void minesPage.load()
})
onUnmounted(() => {
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
      @tab="(target) => preset.send({ kind: 'tab', preset: target })"
      @arrow="(key) => preset.send({ kind: 'arrow', key })"
      @leave="(move) => preset.send({ kind: 'leave', move })"
    />
    <div ref="body" class="dm-valle__body" :style="{ '--chat-w': chatWidth }">
      <nav class="dm-valle__nav" aria-label="Valle">
        <NavSlot
          v-for="slot in NAV_SLOTS"
          :key="slot.id"
          :icon="slot.icon"
          :label="slot.label"
          :data-slot="slot.id"
          :current="slot.area === view.page"
          @click="nav(slot.area)"
        />
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
        :content="mosaic.frontContent.value"
        :menu="frontMenu"
        @menu="toggleMenu({ preset: 'front' })"
        @menu-pick="(id) => mosaic.pickMenu(id)"
        @menu-dismiss="mosaic.dismiss()"
        @fold="preset.send({ kind: 'fold' })"
        @unfold="preset.send({ kind: 'unfold' })"
        @pick="(mineId) => preset.send({ kind: 'pick', mineId })"
      >
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
        :columns="columns"
        :menu="columnMenu"
        :slot-entries="mosaic.slot.value"
        :notice="mosaic.notice.value"
        @menu="(mineId) => toggleMenu({ preset: 'control', mineId })"
        @menu-pick="(id) => mosaic.pickMenu(id)"
        @menu-dismiss="mosaic.dismiss()"
        @slot-open="mosaic.openSlot()"
        @slot-dismiss="mosaic.dismiss()"
        @slot-pick="(mineId) => mosaic.pickSlot(mineId)"
        @slot-new="mosaic.newProject()"
        @dive="(mineId) => preset.send({ kind: 'dive', mineId })"
        @sprite-double-click="preset.send({ kind: 'sprite-double-click' })"
      >
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
          @select="(key) => split.sendPin({ kind: 'select', key })"
          @unpin="(key) => split.sendPin({ kind: 'unpin', key })"
        />
        <ChatDeck
          v-else
          :pins="pins.views.value"
          :focus="pins.set.value.focus"
          :focus-request="pins.focusRequest.value"
          :split="deckSplit"
          @select="(key) => split.sendPin({ kind: 'select', key })"
          @unpin="(key) => split.sendPin({ kind: 'unpin', key })"
          @drag="(key) => split.sendPin({ kind: 'drag', key })"
          @drop="(order) => split.sendPin({ kind: 'drop', order })"
          @drag-cancel="split.sendPin({ kind: 'drag-cancel' })"
          @split="split.press()"
        />
      </aside>
    </div>
    <div class="dm-vghosts" aria-hidden="true"></div>
    <WorktreeDialog
      :question="mosaic.worktree.value"
      :adding="mosaic.adopting.value"
      @accept="mosaic.answerWorktree(true)"
      @dismiss="mosaic.answerWorktree(false)"
    />
    <ToastHost />
  </main>
</template>

<style scoped>
.valle {
  position: relative;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  width: 100vw;
  height: 100vh;
  overflow: hidden;
}
.dm-valle__body {
  display: grid;
  grid-template-columns: 56px minmax(0, 1fr) 12px var(--chat-w);
  gap: 6px;
  min-width: 0;
  min-height: 0;
  padding: 6px;
}
.dm-valle__nav {
  display: flex;
  flex-direction: column;
  gap: 6px;
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
