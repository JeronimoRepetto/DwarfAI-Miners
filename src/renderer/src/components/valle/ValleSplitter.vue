<script setup lang="ts">
/*
 * The splitter between Valle's mines and its chats (`DS/docs/components.md` molecules/splitter; 07 machine 33;
 * US-VALLE-005; NFR-A11Y-06; ISSUE-305): a 12 px rock channel with three brass rivets, `role=separator` with the chat
 * zone's width and range kept live in `aria-valuenow/min/max`. It draws and reports; machine 33 decides
 * (`useValleSplitter`).
 *
 * - A press of the primary button captures the pointer; each move while dragging reports its `clientX`; the release
 *   and a pointercancel end the drag. A drag is direct manipulation: nothing on it transitions.
 * - ← / →, Home / End and Enter on the focused splitter are reported as keys; a double click as a reset.
 */
import type { SplitterKey } from '../../lib/valle/splitter'

const props = defineProps<{
  /** The chat zone's width now. */
  width: number
  min: number
  max: number
  dragging: boolean
}>()
const emit = defineEmits<{
  press: [x: number]
  move: [x: number]
  release: []
  cancel: []
  key: [key: SplitterKey]
  reset: []
}>()

/** `DS` molecules/splitter: its aria-label, and its title built as `{label} · drag, or double-click to reset`. */
const LABEL = 'Resize the chats'
const TITLE = `${LABEL} · drag, or double-click to reset`

const KEYS: readonly string[] = ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter']

function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0) return
  event.preventDefault()
  const bar = event.currentTarget as HTMLElement
  if (typeof bar.setPointerCapture === 'function' && event.pointerId !== undefined) {
    try {
      bar.setPointerCapture(event.pointerId)
    } catch {
      // A pointer that is no longer active cannot be captured; the drag still follows it over the bar.
    }
  }
  emit('press', event.clientX)
}

function onPointerMove(event: PointerEvent): void {
  if (props.dragging) emit('move', event.clientX)
}

function onPointerUp(): void {
  if (props.dragging) emit('release')
}

function onPointerCancel(): void {
  if (props.dragging) emit('cancel')
}

function onKeyDown(event: KeyboardEvent): void {
  if (!KEYS.includes(event.key)) return
  event.preventDefault()
  emit('key', event.key as SplitterKey)
}
</script>

<template>
  <div
    class="dm-split"
    :class="{ 'is-dragging': dragging }"
    role="separator"
    tabindex="0"
    aria-orientation="vertical"
    :aria-label="LABEL"
    :title="TITLE"
    :aria-valuenow="Math.round(width)"
    :aria-valuemin="Math.round(min)"
    :aria-valuemax="Math.round(max)"
    data-valle-splitter
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerCancel"
    @dblclick="emit('reset')"
    @keydown="onKeyDown"
  >
    <span class="dm-split__grip" aria-hidden="true"><i></i><i></i><i></i></span>
  </div>
</template>

<style scoped>
/* `DS/docs/components.md` molecules/splitter, Geometry: the hit area is the full 12 px channel and the full height. */
.dm-split {
  position: relative;
  display: grid;
  place-items: center;
  width: 12px;
  height: 100%;
  min-height: 32px;
  cursor: col-resize;
  touch-action: none;
  background: var(--rock-lo);
  box-shadow:
    inset 2px 0 0 0 var(--rock-hi),
    inset -2px 0 0 0 var(--wood-lo);
}
.dm-split__grip {
  display: grid;
  gap: 4px;
  pointer-events: none;
}
.dm-split__grip i {
  display: block;
  width: 4px;
  height: 4px;
  background: var(--brass-lo);
  box-shadow: inset -2px -2px 0 0 var(--gold-deep);
}
.dm-split:hover .dm-split__grip i,
.dm-split.is-dragging .dm-split__grip i {
  background: var(--brass);
  box-shadow: inset -2px -2px 0 0 var(--brass-lo);
}
.dm-split.is-dragging {
  background: var(--wood-lo);
}
</style>
