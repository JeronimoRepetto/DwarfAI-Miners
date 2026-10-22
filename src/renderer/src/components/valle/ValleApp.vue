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
 *   the chat zone never move. The zones' contents, the pins' own chats and the splitter arrive with their
 *   issues (ISSUE-301…ISSUE-310; hidden until built, 21 §1 item 8).
 * - Restored once the Host's facts are first read (S32.02): the mosaic order, a mine that no longer exists dropped. The
 *   restore never rewrites the persisted stores.
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
import { useVallePins } from '../../composables/useVallePins'
import { useVallePreset } from '../../composables/useVallePreset'
import { useVallePresence, type VallePresenceDeps } from '../../composables/useVallePresence'
import {
  browserBodyObserver,
  useValleSplit,
  type ValleBodyObserver
} from '../../composables/useValleSplit'
import { useValleStores, type ValleStores } from '../../composables/useValleStores'
import { useToasts } from '../../composables/useToasts'
import { SYSTEM_SLOTS, WORLD_SLOTS, type PanelNavSlot } from '../../lib/shell/panelNav'
import {
  BROWSER_CLOCK,
  createInputGate,
  createValleStage,
  type ValleClock
} from '../../lib/valle/flip'
import { valleChatWidth, type ValleFacts, type ValleNavPage } from '../../lib/valle/preset'
import { createVetaMotion } from '../../lib/veta/vetaMotion'
import { restoreMosaicOrder } from '../../lib/valle/restore'
import { createValleReadModel } from '../../lib/valle/valleReadModel'
import ToastHost from '../overlay/ToastHost.vue'
import ChatDeck from './ChatDeck.vue'
import NavSlot from '../shell/NavSlot.vue'
import ValleControlRoom from './ValleControlRoom.vue'
import ValleNavPageView from './ValleNavPage.vue'
import PinnedStack from './PinnedStack.vue'
import ValleTopBar from './ValleTopBar.vue'
import ValleWorkFront from './ValleWorkFront.vue'
import { VALLE_TRACK_ZONE } from './valleZones'
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
const mineExists = (mineId: MineId): boolean => model.mines.value.some((mine) => mine.id === mineId)
const pins = useVallePins({
  bridge: props.bridge,
  stores,
  model,
  factsRead,
  talkedLast: () => stores.value.session.panelOpenChat ?? null
})
const columns = computed(() => {
  const order = factsRead.value ? restoreMosaicOrder(stores.value.mosaicOrder, mineExists) : null
  return (order ?? []).map((mineId) => ({
    mineId,
    name: model.mines.value.find((mine) => mine.id === mineId)?.name ?? '',
    enterable: enterable(mineId)
  }))
})

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
const chatWidth = computed(() => `${valleChatWidth(view.value)}px`)

function onKey(event: KeyboardEvent): void {
  // No menu, drawer or picker is built in Valle yet: Esc leaves a page, then the Work front (NFR-A11Y-02).
  if (event.key === 'Escape') preset.send({ kind: 'escape', layerOpen: false })
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
          @click="preset.send({ kind: 'nav', page: slot.area })"
        />
      </nav>
      <ValleNavPageView v-if="view.page !== null" :page="view.page" />
      <ValleWorkFront
        v-else-if="view.preset === 'front'"
        :folded-list="view.layouts.front.foldedList"
        :mines="listMines"
        :mine="shownMine"
        @fold="preset.send({ kind: 'fold' })"
        @unfold="preset.send({ kind: 'unfold' })"
        @pick="(mineId) => preset.send({ kind: 'pick', mineId })"
      />
      <ValleControlRoom
        v-else
        ref="room"
        :columns="columns"
        @dive="(mineId) => preset.send({ kind: 'dive', mineId })"
        @sprite-double-click="preset.send({ kind: 'sprite-double-click' })"
      />
      <span class="dm-valle__splitter" aria-hidden="true"></span>
      <aside class="dm-valle__chats" aria-label="Pinned chats">
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
