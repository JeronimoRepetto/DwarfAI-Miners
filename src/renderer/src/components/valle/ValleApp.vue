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
 *   the chat zone never move. The zones' contents, the pins' own chats, the splitter and the split arrive with their
 *   issues (ISSUE-301…ISSUE-310; hidden until built, 21 §1 item 8).
 * - Restored once the Host's facts are first read (S32.02): the mosaic order, a mine that no longer exists dropped. The
 *   restore never rewrites the persisted stores.
 * - The pinned chats (`useVallePins`, 07 machines 18, 29; ISSUE-302): restored once the Host's facts are read (S29.02),
 *   or the start-up pins on a first visit (S29.01); drawn as the Control room's stack (`PinnedStack`) or the Work
 *   front's tabs (`ChatDeck`) in the one chat zone, which never moves. Every change is written at once (A-N21 `pins`,
 *   A-N18 for the session's fields); the chat in focus is the one "▼ Panel" / "▼ Veta" carry. The chats themselves
 *   (the MessagePanel and the Add panel inside a pin) are hosted in the stack's and the deck's `chat` slot.
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
import { computed, onMounted, onUnmounted, provide, shallowRef } from 'vue'
import { useValleArrivalToast } from '../../composables/useValleArrivalToast'
import { useVallePins } from '../../composables/useVallePins'
import { useVallePreset } from '../../composables/useVallePreset'
import { useVallePresence, type VallePresenceDeps } from '../../composables/useVallePresence'
import { useValleStores, type ValleStores } from '../../composables/useValleStores'
import { useToasts } from '../../composables/useToasts'
import { SYSTEM_SLOTS, WORLD_SLOTS, type PanelNavSlot } from '../../lib/shell/panelNav'
import { valleChatWidth, type ValleNavPage } from '../../lib/valle/preset'
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
}>()

const { stores } = useValleStores(props.bridge, props.stores)
const model = createValleReadModel(props.bridge)

const preset = useVallePreset({
  bridge: props.bridge,
  stores,
  // S28.06: the Work front needs a mine to dive into.
  facts: () => ({ enterableMine: model.mines.value.some((mine) => mine.state !== 'unenterable') })
})
const view = preset.view

/** Whether Valle is the shown mode window: a hidden window's page is hidden (ADR-025 item 7). */
const shown = shallowRef(document.visibilityState === 'visible')
const visibilityChanged = (): void => {
  shown.value = document.visibilityState === 'visible'
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
    name: model.mines.value.find((mine) => mine.id === mineId)?.name ?? ''
  }))
})

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

onMounted(() => {
  void model.start().then((read) => {
    if (read) factsRead.value = true
  })
})
onUnmounted(() => {
  document.removeEventListener('visibilitychange', visibilityChanged)
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('resize', resized)
  model.stop()
})
</script>

<template>
  <main
    class="valle"
    data-valle-root
    :data-preset="view.preset"
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
    <div class="dm-valle__body" :style="{ '--chat-w': chatWidth }">
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
        @fold="preset.send({ kind: 'fold' })"
        @unfold="preset.send({ kind: 'unfold' })"
      />
      <ValleControlRoom v-else :columns="columns" />
      <span class="dm-valle__splitter" aria-hidden="true"></span>
      <aside class="dm-valle__chats" aria-label="Pinned chats">
        <PinnedStack
          v-if="view.preset === 'control'"
          :pins="pins.views.value"
          :focus="pins.set.value.focus"
          :focus-request="pins.focusRequest.value"
          @select="(key) => pins.send({ kind: 'select', key })"
          @unpin="(key) => pins.send({ kind: 'unpin', key })"
        />
        <ChatDeck
          v-else
          :pins="pins.views.value"
          :focus="pins.set.value.focus"
          :focus-request="pins.focusRequest.value"
          @select="(key) => pins.send({ kind: 'select', key })"
          @unpin="(key) => pins.send({ kind: 'unpin', key })"
          @drag="(key) => pins.send({ kind: 'drag', key })"
          @drop="(order) => pins.send({ kind: 'drop', order })"
          @drag-cancel="pins.send({ kind: 'drag-cancel' })"
        />
      </aside>
    </div>
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
.dm-valle__chats {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
</style>
