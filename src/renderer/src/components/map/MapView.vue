<script setup lang="ts">
/**
 * The world map (#136): the design's time-of-day painting, every mine drawn as
 * a pulsing tier-coloured hexagon on one of its 74 spawn locations, and the
 * hover tooltip.
 *
 * This view owns three things the markers cannot: the measured size of the map
 * box, without which a spawn point authored ON the painting cannot be turned
 * into a position IN the panel; which marker the pointer has been resting on
 * and for how long; and the one tooltip, since only ever one is open and it has
 * to be held inside this box rather than inside a 22px marker.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { MAP_ART_SIZE, MAP_BG_SRC } from '../../lib/art'
import { clampToMapBox, projectToMapBox } from '../../lib/map/mapProjection'
import { MAP_TIME_REFRESH_MS, mapVariantAt } from '../../lib/map/mapTime'
import {
  MAP_TOOLTIP_DELAY_MS,
  mineTooltipCopy,
  placeMapTooltip,
  type MineTooltipCopy
} from '../../lib/map/mapTooltip'
import type { MapSpawnPoint } from '../../lib/map/spawnPoints.generated'
import { MAP_SPAWN_POINTS } from '../../lib/map/spawnPoints.generated'
import { assignSlots } from '../../lib/placement'
import type { MaterialTotals, Mine } from '../../types'
import MineMarker from './MineMarker.vue'
import VaultChip from '../vault/VaultChip.vue'

const props = withDefaults(
  defineProps<{
    mines: Mine[]
    tokensObserved?: number
    /**
     * The WHOLE vault by material, not the sum of the mines on screen: main
     * sums it over the entire persisted ledger, so it includes projects with no
     * crew today — which is the only place backfilled coal can appear (see #22).
     */
    materials?: MaterialTotals
  }>(),
  { tokensObserved: 0, materials: undefined }
)

const emit = defineEmits<{ open: [mineId: string] }>()

/**
 * The painting the valley is wearing, re-read from the clock on a slow tick
 * (see MAP_TIME_REFRESH_MS for why a tick and not one alarm at the boundary).
 * The interval is cleared on unmount: the panel switches between five screens
 * all day, and a timer left running per visit is a leak nothing on screen would
 * ever show.
 */
const timeVariant = ref(mapVariantAt(new Date()))
const mapArtSrc = computed(() => MAP_BG_SRC[timeVariant.value])
let clockTick: ReturnType<typeof setInterval> | null = null

/**
 * The rendered size of the map box, which decides how much of the painting the
 * `cover` crop leaves and therefore where every spawn point lands.
 *
 * Zero until something measures it, which is the projection's own documented
 * fallback: an unmeasured box draws the authored coordinates unchanged, so the
 * first frame is right for the shape the art was authored at and settles onto
 * the real one as soon as the observer reports.
 */
const mapRef = ref<HTMLElement | null>(null)
const boxSize = ref({ width: 0, height: 0 })
let boxObserver: ResizeObserver | undefined

onMounted(() => {
  clockTick = setInterval(() => {
    timeVariant.value = mapVariantAt(new Date())
  }, MAP_TIME_REFRESH_MS)

  const element = mapRef.value
  if (!element) return
  const measure = (): void => {
    const rect = element.getBoundingClientRect()
    // A zero rect means "not laid out yet", never "the map is empty": keeping
    // the last good size is what stops a hidden panel collapsing every marker
    // into one corner.
    if (rect.width > 0 && rect.height > 0) {
      boxSize.value = { width: rect.width, height: rect.height }
    }
  }
  measure()
  // The panel is user-resizable and the crop moves with its shape, so the map
  // has to re-measure exactly as the cave does.
  if (typeof ResizeObserver === 'function') {
    boxObserver = new ResizeObserver(measure)
    boxObserver.observe(element)
  }
})

onBeforeUnmount(() => {
  if (clockTick !== null) clearInterval(clockTick)
  clockTick = null
  boxObserver?.disconnect()
  clearHoverTimer()
})

/**
 * Spawn points by their own id, because the id is what the store persists and
 * the array's order is only a drawing order. Built once: the table is generated
 * and never changes at runtime.
 */
const pointById = new Map(MAP_SPAWN_POINTS.map((point) => [point.id, point]))

/**
 * Somewhere stable for the mines nobody has placed.
 *
 * Two kinds reach here: a simulated valley, which never touches the projects
 * store at all (#42), and a project in the poll or two before its first row is
 * written. Both still have to be drawn, and drawn in the same spot on the next
 * poll, so the fallback is the deterministic id hash the cave already uses for
 * its dwarfs. It runs over the unplaced mines only, so it cannot be pushed
 * around by a mine that has a real location — though it can, briefly, land on
 * one, which is a second of overlap in a state that lasts one poll.
 */
const fallbackSlots = computed(() =>
  assignSlots(
    props.mines.filter((mine) => mine.mapSite === undefined).map((mine) => mine.id),
    MAP_SPAWN_POINTS.length
  )
)

function pointFor(mine: Mine): MapSpawnPoint {
  const remembered = mine.mapSite === undefined ? undefined : pointById.get(mine.mapSite)
  if (remembered !== undefined) return remembered
  /* Falls back to the first spawn point rather than a bare centre, so a mine
     that somehow missed both paths still lands on real painted ground. */
  return MAP_SPAWN_POINTS[fallbackSlots.value.get(mine.id) ?? 0] ?? MAP_SPAWN_POINTS[0]
}

/**
 * Where a mine's marker sits in the box, in box percent.
 *
 * Projected from the painting through the same `cover` crop the browser
 * applies, then held inside the box by half a marker: the design's own map
 * container is exactly the painting's ratio and never crops, ours is
 * resizable, and a live mine cropped off the edge is a project the user cannot
 * see. See mapProjection.ts.
 */
function markerPercent(mine: Mine): { x: number; y: number } {
  const box = boxSize.value
  const projected = projectToMapBox(pointFor(mine), box, MAP_ART_SIZE)
  if (box.width <= 0 || box.height <= 0) return projected
  return clampToMapBox(
    projected,
    (MARKER_HALF_PX / box.width) * 100,
    (MARKER_HALF_PX / box.height) * 100
  )
}

/**
 * Half the marker's widest DRAWN extent, so a clamped marker sits fully inside
 * the map — its light included.
 *
 * It was half the 22px hit box until #156 gave the marker a real pulsing light:
 * a 30px bloom at rest and 37.5px at the top of its beat, which is what decides
 * the margin now. Only a marker already being clamped moves at all, and it moves
 * so that the light the clamp exists to protect is not the part that gets cut.
 */
const MARKER_HALF_PX = 19

function markerStyle(mine: Mine): Record<string, string> {
  const point = markerPercent(mine)
  return {
    left: `${point.x}%`,
    top: `${point.y}%`,
    /* Nearer markers over farther ones, so an overlap reads as depth rather
       than as whichever mine the board happened to list last. */
    zIndex: `${Math.round(pointFor(mine).y)}`
  }
}

/**
 * The marker the pointer is resting on, once it has rested the design's 300ms.
 *
 * Held as an id rather than a mine so it survives a poll replacing the board:
 * the tooltip then keeps describing the same project with fresh numbers instead
 * of vanishing under the user's pointer every two seconds.
 */
const tooltipMineId = ref<string | null>(null)
let hoverTimer: ReturnType<typeof setTimeout> | null = null

function clearHoverTimer(): void {
  if (hoverTimer !== null) clearTimeout(hoverTimer)
  hoverTimer = null
}

/** Hover has to be CONTINUOUS, so a pointer merely crossing a marker restarts nothing. */
function hoverMarker(mineId: string): void {
  clearHoverTimer()
  hoverTimer = setTimeout(() => {
    tooltipMineId.value = mineId
  }, MAP_TOOLTIP_DELAY_MS)
}

/**
 * Keyboard focus shows the tooltip AT ONCE, which is a decision — the design
 * marks keyboard access Unspecified. The 300ms exists so a pointer sweeping the
 * map does not flash tooltips behind it; someone who tabbed onto a marker has
 * already chosen it deliberately, and making them wait would only look broken.
 */
function focusMarker(mineId: string): void {
  clearHoverTimer()
  tooltipMineId.value = mineId
}

function leaveMarker(): void {
  clearHoverTimer()
  tooltipMineId.value = null
}

const tooltipMine = computed(() => props.mines.find((mine) => mine.id === tooltipMineId.value))
const tooltipCopy = computed<MineTooltipCopy | null>(() =>
  tooltipMine.value === undefined ? null : mineTooltipCopy(tooltipMine.value)
)
const tooltipStyle = computed<Record<string, string>>(() => {
  const mine = tooltipMine.value
  if (mine === undefined) return { left: '0px', top: '0px' }
  const box = boxSize.value
  const percent = markerPercent(mine)
  const placed = placeMapTooltip(
    { x: (percent.x / 100) * box.width, y: (percent.y / 100) * box.height },
    box
  )
  return { left: `${placed.left}px`, top: `${placed.top}px` }
})
</script>

<template>
  <div ref="mapRef" class="map-view" aria-label="World map of active mines">
    <img
      class="map-art"
      :src="mapArtSrc"
      :data-variant="timeVariant"
      alt=""
      aria-hidden="true"
      draggable="false"
    />
    <VaultChip :tokens-observed="tokensObserved" :materials="materials" />
    <p v-if="mines.length === 0" class="map-empty">
      The hills are quiet.<br />
      No agents are mining right now — start a coding session and a mine will appear.
    </p>
    <!--
      One layer for every marker, so their spawn-point depths (which run to 99)
      stack against each other and not against the rest of the map: the layer
      takes its own place in the map's order, under the vault chip and under the
      tooltip. Without it a marker clamped to the top edge of a wide panel draws
      over the totals the design puts in that corner.
    -->
    <div class="map-markers">
      <MineMarker
        v-for="mine in mines"
        :key="mine.id"
        :mine="mine"
        :style="markerStyle(mine)"
        @open="emit('open', $event)"
        @mouseenter="hoverMarker(mine.id)"
        @mouseleave="leaveMarker"
        @focusin="focusMarker(mine.id)"
        @focusout="leaveMarker"
      />
    </div>
    <div v-if="tooltipCopy" class="mine-tooltip" role="tooltip" :style="tooltipStyle">
      <span class="tooltip-tier">{{ tooltipCopy.tier }}</span>
      <span class="tooltip-name">{{ tooltipCopy.name }}</span>
      <span class="tooltip-agents">{{ tooltipCopy.agents }}</span>
    </div>
  </div>
</template>

<style scoped>
.map-view {
  position: relative;
  overflow: hidden;
  min-height: 100%;
  background: var(--color-panel-deep);
}
.map-art {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  /*
    `contain`, not the `cover` screens/map.md asks for: the maintainer's first
    acceptance run ruled that the whole painting must be visible with its aspect
    preserved and no crop (#153), and the secondary column's own width is derived
    from the display's height so that the height it is drawn at is the whole of
    the one it is given (see secondaryColumnWidth in main/shell/panelBounds.ts).
    Centred on both axes, which is what mapProjection's fit maths assumes.
  */
  object-fit: contain;
  object-position: 50% 50%;
  user-select: none;
}
/*
  The markers' own stacking context. `pointer-events: none` because it covers
  the whole map: the markers inside turn it back on, and everything else on the
  map — the chip above it, the painting below — keeps its own hover.
*/
.map-markers {
  position: absolute;
  z-index: 1;
  inset: 0;
  pointer-events: none;
}
.map-empty {
  position: absolute;
  z-index: 2;
  top: 42%;
  left: 50%;
  max-width: 280px;
  margin: 0;
  color: var(--color-tooltip-text);
  font-size: 13px;
  line-height: 1.6;
  text-align: center;
  text-shadow: 0 1px 4px #000;
  translate: -50% -50%;
}
/*
  The design's tooltip, to the pixel: 170x60, #2b2119 at 90%, 12px radius, a 2px
  cream border, elevation 5, and 10px #f7dcaf copy aligned to the start. Its
  z-index clears every marker, whose own z-indices are spawn-point depths
  running to 99.
*/
.mine-tooltip {
  position: absolute;
  z-index: 200;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
  width: var(--size-tooltip-width);
  height: var(--size-tooltip-height);
  padding: 6px 8px;
  border: var(--border-highlight);
  border-radius: var(--radius-default);
  color: var(--color-tooltip-text);
  background: var(--color-panel);
  box-shadow: var(--elevation-5);
  font-size: var(--text-meta);
  line-height: 1.25;
  text-align: left;
  opacity: 0.9;
  /* Never a click target: it appears under the pointer that summoned it. */
  pointer-events: none;
}
.mine-tooltip span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
