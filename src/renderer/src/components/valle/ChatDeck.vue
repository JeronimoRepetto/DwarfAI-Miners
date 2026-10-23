<script setup lang="ts">
/*
 * The Work front's chat tabs (`DS/docs/components.md` organisms/chat-deck, molecules/chat-tab; 07 machine 29;
 * US-VALLE-007; ISSUE-302): a tablist named "Pinned chats", one tab per pin in order, and below it the selected tab's
 * pane, its chat in the `chat` slot. A tab carries its dwarf's name and only "?" while the dwarf needs the person
 * (AC13); an Add panel's tab reads "New dwarf".
 *
 * - A click, or Enter/Space on a focused tab, selects it: its pane replaces the shown chat (AC09, AC11; S29.05).
 * - ← and → move keyboard focus between tabs, wrapping at both ends, without changing the selection (AC10; S29.06).
 *   The story wins over the design's "select as they move" (DS organisms/chat-deck, Accessibility).
 * - Delete or Backspace on a focused tab, × ("Unpin `<name>`") or a middle click unpin it; its session keeps running
 *   (AC03). Keyboard focus then goes where machine 29 says (`focusRequest`): the tab that took its place, else the one
 *   before it, else the deck itself (tabindex -1), never dropped (AC04).
 * - Dragging a tab moves it among the others as it crosses them; the drop commits the order, a drag ended any other
 *   way (Esc included) keeps it (AC05; S29.07…S29.09).
 * - "⫽" beside the strip shows two chats side by side, never three (07 machine 30; US-VALLE-008; ISSUE-303): a toggle
 *   reporting `aria-pressed`, disabled and titled as machine 30 says. With both panes shown both tabs read as selected;
 *   only the focused pane's tab carries the brass edge (`is-focus-pane`), and its pane the brass outline (`is-focus`),
 *   which shows only in a split (AC07). A press in the other pane selects its chat (S30.09).
 * - The mine's history opens as a drawer under the panes (07 machine 36; US-VALLE-011; ISSUE-308), drawn in the
 *   `drawer` slot; the deck then gives it the row the design gives it (`data-drawer="open"`) and the tabs and panes
 *   above stay where they are. The History bar at its foot, "History · opens under the chats", reports whether it is
 *   open (`aria-expanded`) and asks for it (`history`).
 *
 * With no pin at all the guidance line replaces the tabs and panes and "⫽" stays disabled (07 machine 38, S30.03;
 * US-VALLE-015; ISSUE-310): a pure read of the pins, nothing stored.
 *
 * Presentational: the set, its selection and every decision are the Valle root's (`useVallePins`).
 */
import { computed, nextTick, ref, shallowRef, watch } from 'vue'
import { DECK_EMPTY_TEXT, deckState } from '../../lib/valle/emptyStates'
import { arrowTarget, type FocusRequest, type PinKey, type PinView } from '../../lib/valle/pins'
import type { SplitButton } from '../../lib/valle/split'
import ActionButton from '../controls/ActionButton.vue'
import PixelIcon from '../icon/PixelIcon.vue'

/** The split as the Work front shows it: the panes, first then second, and "⫽". */
export interface DeckSplit {
  readonly panes: readonly PinKey[]
  readonly button: SplitButton
}

const props = defineProps<{
  pins: readonly PinView[]
  /** The selected tab. */
  focus: PinKey | null
  focusRequest: FocusRequest | null
  /** Machine 30's panes and "⫽"; absent, the selected tab's pane alone and no "⫽". */
  split?: DeckSplit | null
  /** The history drawer (machine 36): whether it is drawn; absent, no History bar. */
  history?: { readonly open: boolean } | null
}>()
const emit = defineEmits<{
  select: [key: PinKey]
  unpin: [key: PinKey]
  drag: [key: PinKey]
  drop: [order: readonly PinKey[]]
  'drag-cancel': []
  split: []
  /** The History bar pressed. */
  history: []
}>()

const root = ref<HTMLElement | null>(null)
/** Machine 38: with no pin at all (other mines' pins are tabs too, V-03) the guidance line replaces tabs and panes. */
const empty = computed(() => deckState({ pins: props.pins }) === 'deck-empty')
/** The tab keyboard focus is on (roving tabindex); the selected one when none was focused yet. */
const rover = shallowRef<PinKey | null>(null)
/** The strip's order while a tab is dragged, before the drop commits it. */
const preview = shallowRef<PinKey[] | null>(null)
/** The tab being dragged (its dragging look). */
const dragged = shallowRef<PinKey | null>(null)
let dropped = false

const shown = computed((): readonly PinView[] => {
  const order = preview.value
  if (order === null) return props.pins
  return order.flatMap((key) => props.pins.filter((pin) => pin.key === key))
})
/** The panes shown, first then second: the split's two, else the selected tab's. */
const panes = computed((): readonly PinView[] => {
  const keys = props.split?.panes ?? (props.focus === null ? [] : [props.focus])
  return keys.flatMap((key) => props.pins.filter((pin) => pin.key === key)).slice(0, 2)
})
const splitShown = computed(() => panes.value.length === 2)
const isShown = (key: PinKey): boolean => panes.value.some((pane) => pane.key === key)

/** S30.09: a press in the other pane selects its chat. */
function onPanePress(key: PinKey): void {
  if (key !== props.focus) emit('select', key)
}
const inTabOrder = computed(() => {
  const key = rover.value
  return key !== null && props.pins.some((pin) => pin.key === key) ? key : props.focus
})

async function focusTab(key: PinKey | null): Promise<void> {
  await nextTick()
  const host = root.value
  if (host === null) return
  const tab =
    key === null ? null : host.querySelector<HTMLElement>(`[role="tab"][data-pin="${key}"]`)
  ;(tab ?? host).focus({ preventScroll: true })
}

watch(
  () => props.focusRequest,
  (request) => {
    if (request === null) return
    const key = request.target === 'container' ? null : request.target
    rover.value = key
    void focusTab(key)
  }
)

function onKey(event: KeyboardEvent, key: PinKey): void {
  switch (event.key) {
    case 'ArrowLeft':
    case 'ArrowRight': {
      event.preventDefault()
      const target = arrowTarget({ pins: shown.value }, key, event.key)
      rover.value = target
      void focusTab(target)
      return
    }
    case 'Enter':
    case ' ':
      event.preventDefault()
      emit('select', key)
      return
    case 'Delete':
    case 'Backspace':
      event.preventDefault()
      emit('unpin', key)
      return
  }
}

function onAuxClick(event: MouseEvent, key: PinKey): void {
  if (event.button === 1) {
    event.preventDefault()
    emit('unpin', key)
  }
}

function onDragStart(event: DragEvent, key: PinKey): void {
  dragged.value = key
  dropped = false
  preview.value = props.pins.map((pin) => pin.key)
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', '')
  }
  emit('drag', key)
}

/** The dragged tab moves to the place of the tab it is over. */
function onDragOver(event: DragEvent, key: PinKey): void {
  event.preventDefault()
  const order = preview.value
  const moving = dragged.value
  if (order === null || moving === null || key === moving) return
  const next = order.filter((k) => k !== moving)
  next.splice(order.indexOf(key), 0, moving)
  preview.value = next
}

function onDrop(event: DragEvent): void {
  event.preventDefault()
  if (preview.value === null || dropped) return
  dropped = true
  emit('drop', preview.value)
}

function onDragEnd(): void {
  if (preview.value !== null && !dropped) emit('drag-cancel')
  preview.value = null
  dragged.value = null
}
</script>

<template>
  <section
    ref="root"
    class="dm-cdeck"
    aria-label="Chats"
    tabindex="-1"
    :data-drawer="history?.open ? 'open' : undefined"
  >
    <header class="dm-cdeck__head m-mat">
      <div
        class="dm-cdeck__tabs"
        role="tablist"
        aria-label="Pinned chats"
        @dragover.prevent
        @drop="onDrop"
      >
        <div
          v-for="pin in shown"
          :key="pin.key"
          class="dm-ctab m-mat"
          :class="{ 'is-dragging': pin.key === dragged, 'is-focus-pane': pin.key === focus }"
          role="tab"
          draggable="true"
          :tabindex="pin.key === inTabOrder ? 0 : -1"
          :aria-selected="isShown(pin.key) ? 'true' : 'false'"
          :aria-label="pin.text.tabLabel"
          :data-pin="pin.key"
          :data-pin-mine="pin.mineId"
          :data-pin-state="pin.state"
          :data-needs="pin.text.needs ? 'true' : 'false'"
          @click="emit('select', pin.key)"
          @focus="rover = pin.key"
          @keydown="onKey($event, pin.key)"
          @auxclick="onAuxClick($event, pin.key)"
          @dragstart="onDragStart($event, pin.key)"
          @dragover="onDragOver($event, pin.key)"
          @dragend="onDragEnd"
        >
          <span v-if="pin.kind === 'add'" class="dm-ctab__add" aria-hidden="true">+</span>
          <span class="dm-ctab__name">{{ pin.text.name }}</span>
          <span class="dm-ctab__ask" aria-hidden="true">{{ pin.text.tab }}</span>
          <button
            type="button"
            class="dm-ctab__x"
            tabindex="-1"
            draggable="false"
            :aria-label="pin.text.unpinLabel"
            title="Unpin · or middle-click the tab"
            @click.stop="emit('unpin', pin.key)"
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
      </div>
      <ActionButton
        v-if="split"
        class="dm-cdeck__split"
        label="⫽"
        size="sm"
        :title="split.button.title"
        :pressed="split.button.pressed"
        :disabled="split.button.disabled || empty"
        @click="emit('split')"
      />
    </header>
    <div class="dm-cdeck__panes" :data-split="splitShown ? 'true' : 'false'">
      <div
        v-for="pane in panes"
        :key="pane.key"
        class="dm-cdeck__pane"
        :class="{ 'is-focus': splitShown && pane.key === focus }"
        role="tabpanel"
        :aria-label="pane.text.name"
        :data-pane="pane.key"
        :data-read-only="pane.readOnly ? 'true' : 'false'"
        @pointerdown.capture="onPanePress(pane.key)"
      >
        <slot name="chat" :pin="pane" />
      </div>
      <p v-if="empty" class="dm-cdeck__empty">{{ DECK_EMPTY_TEXT }}</p>
    </div>
    <slot name="drawer" />
    <button
      v-if="history"
      type="button"
      class="dm-cdeck__histbar m-mat"
      :aria-expanded="history.open ? 'true' : 'false'"
      @click="emit('history')"
    >
      <PixelIcon name="history" />
      <span>History</span>
      <span class="dm-cdeck__histhint">opens under the chats</span>
    </button>
  </section>
</template>

<style scoped>
/* `DS/docs/components.md` organisms/chat-deck and molecules/chat-tab, Geometry. */
.dm-cdeck {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto auto;
  gap: 4px;
  min-width: 0;
  min-height: 0;
  height: 100%;
}
/* The drawer under the panes: it takes its row, the tabs and panes above stay in place (07 machine 36). */
.dm-cdeck[data-drawer='open'] {
  grid-template-rows: auto minmax(160px, 1fr) minmax(0, 0.9fr) auto;
}
.dm-cdeck__empty {
  align-self: center;
  justify-self: center;
  max-width: 36ch;
  font-family: var(--f-meta);
  font-size: var(--fs-body, 14px);
  line-height: 1.4;
  text-align: center;
  color: var(--ink-faint);
}
.dm-cdeck__histbar {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 36px;
  margin: var(--px, 2px);
  padding: 0 10px;
  font-family: var(--f-label);
  font-size: var(--fs-section, 16px);
  line-height: 1;
  color: var(--ink-soft);
  --mat-fill: var(--wood-lo);
  --mat-hi: var(--wood);
  --mat-lo: var(--rock-lo);
}
.dm-cdeck__histbar:hover {
  color: var(--ink);
  --mat-edge: var(--brass-lo);
}
.dm-cdeck__histbar[aria-expanded='true'] {
  color: var(--parchment);
  --mat-edge: var(--brass-lo);
}
.dm-cdeck__histhint {
  font-family: var(--f-meta);
  font-size: var(--fs-meta, 12px);
  line-height: 1;
  color: var(--ink-faint);
}
.dm-cdeck__head {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  height: 52px;
  padding: 0 4px;
  margin: var(--px, 2px);
  --mat-fill: var(--wood);
}
.dm-cdeck__tabs {
  position: relative;
  display: flex;
  flex: 1;
  align-items: center;
  gap: 2px;
  min-width: 0;
  padding: 2px;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}
.dm-cdeck__tabs::-webkit-scrollbar {
  display: none;
}
.dm-cdeck__panes {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 6px;
  min-width: 0;
  min-height: 0;
}
.dm-cdeck__panes[data-split='true'] {
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
}
.dm-cdeck__pane {
  position: relative;
  display: flex;
  min-width: 0;
  min-height: 0;
}
.dm-cdeck__pane > * {
  flex: 1;
  min-width: 0;
}
/*
 * The MessagePanel or the Add panel in a pane fills it and shrinks with it down to its own min-content width
 * (decision log, MessagePanel width; 07 S33.11): only its root is sized here, so every part inside keeps its own size,
 * and its floor sits on the panel, never on the host, so Valle's minimums do not move for it (US-MSG-015.AC06).
 */
.dm-cdeck__pane > :deep(.dm-msg),
.dm-cdeck__pane > :deep(.dm-add) {
  flex: 1 1 auto;
  width: 100%;
  min-width: min-content;
}
/* The focused pane's brass outline sits on an overlay every pane has, so focus only paints it (NFR-A11Y-01). */
.dm-cdeck__pane::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.dm-cdeck__pane.is-focus::after {
  box-shadow: inset 0 0 0 2px var(--brass);
}
.dm-cdeck__split {
  flex: none;
  font-size: var(--fs-section);
}
.dm-ctab {
  position: relative;
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 6px;
  max-width: 200px;
  height: 40px;
  margin: var(--px, 2px);
  padding: 0 2px;
  cursor: pointer;
  user-select: none;
  color: var(--ink-soft);
  --mat-fill: var(--wood-lo);
  --mat-hi: var(--wood);
  --mat-lo: var(--rock-lo);
  --mat-edge: var(--rock-lo);
}
.dm-ctab:hover {
  color: var(--ink);
  --mat-edge: var(--brass-lo);
}
.dm-ctab[aria-selected='true'] {
  color: var(--parchment);
  --mat-fill: var(--wood-hi);
  --mat-hi: var(--gold-lo);
  --mat-lo: var(--wood-lo);
}
.dm-ctab.is-focus-pane {
  --mat-edge: var(--brass);
}
.dm-ctab__add {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  background: var(--rock);
}
.dm-ctab__name {
  min-width: 0;
  overflow: hidden;
  font-family: var(--f-meta);
  font-size: var(--fs-body, 14px);
  line-height: 1;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.dm-ctab__ask {
  display: none;
  flex: none;
  place-items: center;
  width: 16px;
  height: 16px;
  font-family: var(--f-meta);
  font-size: var(--fs-meta, 12px);
  line-height: 1;
  color: var(--ink-on-light);
  background: var(--brass);
}
.dm-ctab[data-needs='true'] .dm-ctab__ask {
  display: grid;
}
.dm-ctab__x {
  display: grid;
  flex: none;
  place-items: center;
  width: 32px;
  height: 32px;
  opacity: 0.55;
}
.dm-ctab.is-dragging {
  z-index: 3;
  cursor: grabbing;
  --mat-edge: var(--brass-hi);
}
.dm-ctab__x:hover {
  background: var(--rock-lo);
  opacity: 1;
}
</style>
