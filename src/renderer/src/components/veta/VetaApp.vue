<script setup lang="ts">
/*
 * The Veta window's root (ADR-025 item 1; ISSUE-285): its own renderer of the same bundle, mounted for
 * `?mode=veta`. The window around it is transparent and hugs the island, so the root paints nothing of
 * its own; the strip, its chambers and its entrance arrive with ISSUE-287, and the click-through
 * hit-test (useVetaClickThrough, A-N22) with the island it tests against.
 *
 * The dock (ISSUE-286; 07 machine 21): the island holds the grip, laid out along its edge, vertical on a
 * side edge, and its parts run from the anchor outward, so the grip sits at the far end from it. While
 * the grip is dragged the window is the drag surface (the work area of the display under the pointer):
 * the island follows the pointer by transform and the dashed snap preview marks where it would land.
 */
import { VETA_ISLAND_STAND_IN } from '@dwarfai/contracts'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useWindowVetaDock } from '../../composables/useVetaDock'
import { snapRect } from '../../lib/veta/dockGesture'
import VetaGrip from './VetaGrip.vue'

const dock = useWindowVetaDock()
const { vertical, dragging, preview, follow } = dock
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

const islandStyle = computed(() => {
  const size = vertical.value
    ? { width: `${VETA_ISLAND_STAND_IN.thickness}px`, height: `${VETA_ISLAND_STAND_IN.length}px` }
    : { width: `${VETA_ISLAND_STAND_IN.length}px`, height: `${VETA_ISLAND_STAND_IN.thickness}px` }
  return dragging.value
    ? { ...size, transform: `translate(${follow.value.x}px, ${follow.value.y}px)` }
    : size
})

const snapStyle = computed(() => {
  if (preview.value === null) return undefined
  const rect = snapRect(preview.value, pointer.value, surface.value, VETA_ISLAND_STAND_IN)
  return {
    left: `${rect.x}px`,
    top: `${rect.y}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`
  }
})

/** Hidden mid-drag (S21.10, S10.08): the island goes back where it was. */
function visibility(): void {
  if (document.visibilityState === 'hidden') dock.cancel('hidden')
}

onMounted(() => {
  document.addEventListener('visibilitychange', visibility)
  void dock.start()
})
onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', visibility)
  dock.dispose()
})
</script>

<template>
  <div class="veta-root" data-veta-root :data-edge="dock.dock.value.edge">
    <div
      v-if="preview !== null"
      class="veta-snap"
      :data-edge="preview"
      :style="snapStyle"
      aria-hidden="true"
      data-veta-snap
    />
    <div
      class="veta-island"
      :class="{
        'is-dragging': dragging,
        'is-vertical': vertical,
        'is-anchored-end': dock.dock.value.end === 'end'
      }"
      :style="islandStyle"
      data-veta-island
    >
      <VetaGrip
        :vertical="vertical"
        @press="dock.pointerDown(facts($event))"
        @move="move"
        @release="dock.pointerUp(facts($event))"
        @cancel="dock.cancel($event)"
        @key="key"
      />
    </div>
  </div>
</template>

<style scoped>
.veta-root {
  position: relative;
  height: 100%;
  background: transparent;
  overflow: hidden;
}

/* Parts run from the anchor outward, the grip last (DS/docs/screens/veta.md Layout). */
.veta-island {
  position: absolute;
  left: 0;
  top: 0;
  display: flex;
  flex-direction: row;
  justify-content: flex-end;
  align-items: center;
}

.veta-island.is-anchored-end {
  justify-content: flex-start;
}

.veta-island.is-vertical {
  flex-direction: column;
}

.veta-island.is-dragging {
  will-change: transform;
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
