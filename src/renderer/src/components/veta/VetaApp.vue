<script setup lang="ts">
/*
 * The Veta window's root (ADR-025 item 1; ISSUE-285): its own renderer of the same bundle, mounted for `?mode=veta`.
 * The window around it is transparent and hugs the island.
 *
 * The island shows Veta's life state (07 machine 20; US-VETA-001; ISSUE-287), derived from the Host facts and never
 * picked by the person (`useVetaLife`):
 * - `first-run` and `no-sessions`: the closed entrance is the only part and the one click target (US-VETA-011.AC04),
 *   with "+" on first run. It moves to the Panel with no mine (S20.12), or, on first run, asks for the empty mine
 *   picker (S20.13): until the picker lands (ISSUE-288) that intent is all it emits.
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
 */
import { VETA_ISLAND } from '@dwarfai/contracts'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useWindowVetaDock } from '../../composables/useVetaDock'
import { useWindowVetaLife } from '../../composables/useVetaLife'
import { useWindowVetaPresence } from '../../composables/useVetaPresence'
import { snapRect } from '../../lib/veta/dockGesture'
import { islandLength } from '../../lib/veta/island'
import { entranceIntent } from '../../lib/veta/lifeState'
import VetaChamber from './VetaChamber.vue'
import VetaEntrance from './VetaEntrance.vue'
import VetaExpand from './VetaExpand.vue'
import VetaGrip from './VetaGrip.vue'
import VetaIsland from './VetaIsland.vue'

const life = useWindowVetaLife()
const { state, chambers } = life

const closed = computed(() => state.value === 'first-run' || state.value === 'no-sessions')
const sessions = computed(() => state.value === 'all-idle' || state.value === 'sessions-working')

// The dock reads the island's length only once mounted, after `length` below exists.
const dock = useWindowVetaDock(() => length.value)
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

/** S20.13: the empty mine picker was asked for; the picker itself is ISSUE-288's. */
const pickerIntent = ref<'empty' | null>(null)

function enter(): void {
  if (state.value === null) return
  const intent = entranceIntent(state.value)
  if (intent === 'open-panel') life.openPanel()
  else if (intent === 'open-picker') pickerIntent.value = 'empty'
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

const islandStyle = computed(() =>
  dragging.value ? { transform: `translate(${follow.value.x}px, ${follow.value.y}px)` } : undefined
)

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

/** Hidden mid-drag (S21.10, S10.08): the island goes back where it was. */
function visibility(): void {
  if (document.visibilityState === 'hidden') dock.cancel('hidden')
}

let started = false
// A new length re-places the window for it (S21.19); the first is sent by the dock's start.
watch(length, () => {
  if (started) void dock.resized()
})

onMounted(() => {
  document.addEventListener('visibilitychange', visibility)
  void dock.start().then(() => {
    started = true
  })
  void life.start()
})
onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', visibility)
  dock.dispose()
  life.stop()
})
</script>

<template>
  <div
    class="veta-root"
    data-veta-root
    :data-edge="dock.dock.value.edge"
    :data-life="state ?? 'unknown'"
    :data-picker-intent="pickerIntent ?? undefined"
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
          data-veta-part="grip"
          @press="dock.pointerDown(facts($event))"
          @move="move"
          @release="dock.pointerUp(facts($event))"
          @cancel="dock.cancel($event)"
          @key="key"
        />
        <VetaChamber
          v-for="chamber in ordered"
          :key="chamber.mine.id"
          :mine="chamber.mine"
          :dwarfs="chamber.dwarfs"
          :attention="chamber.attention"
          :vertical="vertical"
          :reverse="anchorEnd"
        />
        <!-- "+N" lands here, on the anchor side of the grip (ISSUE-291). -->
        <VetaExpand v-if="anchorEnd" :edge="dock.dock.value.edge" @activate="life.openPanel()" />
        <VetaGrip
          v-if="!anchorEnd"
          :vertical="vertical"
          data-veta-part="grip"
          @press="dock.pointerDown(facts($event))"
          @move="move"
          @release="dock.pointerUp(facts($event))"
          @cancel="dock.cancel($event)"
          @key="key"
        />
      </template>
    </VetaIsland>
  </div>
</template>

<style scoped>
.veta-root {
  position: relative;
  height: 100%;
  background: transparent;
  overflow: hidden;
}

/* The island sits at the window's corner; the window hugs it. */
.veta-root__island {
  position: absolute;
  left: 0;
  top: 0;
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
