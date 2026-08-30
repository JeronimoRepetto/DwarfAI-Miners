<script setup lang="ts">
import { computed, ref } from 'vue'
import { MAP_BG_SRC } from '../lib/art'
import type { MineSite } from '../lib/mapSites'
import { MAP_TRAILS, MINE_SITES, moundLinkClass, trailPoints } from '../lib/mapSites'
import { assignSlots } from '../lib/placement'
import type { MaterialTotals, Mine } from '../types'
import MineMound from './MineMound.vue'
import VaultChip from './VaultChip.vue'

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

const slotByMine = computed(() => assignSlots(props.mines.map((mine) => mine.id)))

/**
 * The mine the pointer or keyboard focus is currently on, or null when the map
 * is at rest. Hover and focus feed the same value on purpose: the highlight is
 * information, so it must be reachable without a mouse.
 */
const hotMineId = ref<string | null>(null)

function siteOf(mineId: string): MineSite {
  /* Falls back to the first site rather than a bare centre point, so a mine
     that somehow missed assignment still lands on real painted ground. */
  return MINE_SITES[slotByMine.value.get(mineId) ?? 0] ?? MINE_SITES[0]
}

function positionStyle(mineId: string): Record<string, string> {
  const site = siteOf(mineId)
  return {
    left: `${site.x}%`,
    top: `${site.y}%`,
    /* Farther sites sit behind nearer ones; y is already the depth order. */
    zIndex: `${Math.round(site.y)}`,
    /* Consumed by MineMound's `scale`, which pivots on the site anchor. */
    '--site-scale': `${site.scale}`
  }
}
</script>

<template>
  <div class="map-view" aria-label="Isometric map of active mines">
    <img class="map-art" :src="MAP_BG_SRC" alt="" aria-hidden="true" draggable="false" />
    <!-- Darkens the edges and the valley floor so the lit mounds carry the eye. -->
    <div class="map-vignette" aria-hidden="true"></div>
    <!--
      The trails belong to the landscape, not to the mines: they are drawn
      whether or not anyone is digging, under the mounds and never interactive.
      preserveAspectRatio="none" makes the viewBox the same 0-100 percent space
      the mounds are positioned in, so a trail point and a site coordinate mean
      exactly the same thing.
    -->
    <svg
      class="map-trails"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      <polyline
        v-for="(trail, index) in MAP_TRAILS"
        :key="index"
        class="map-trail"
        :points="trailPoints(trail)"
        vector-effect="non-scaling-stroke"
      />
    </svg>
    <VaultChip :tokens-observed="tokensObserved" :materials="materials" />
    <p v-if="mines.length === 0" class="map-empty">
      The hills are quiet.<br />
      No agents are mining right now — start a coding session and a mine will appear.
    </p>
    <MineMound
      v-for="mine in mines"
      :key="mine.id"
      :mine="mine"
      :class="moundLinkClass(mine.id, hotMineId)"
      :style="positionStyle(mine.id)"
      @open="emit('open', $event)"
      @mouseenter="hotMineId = mine.id"
      @mouseleave="hotMineId = null"
      @focusin="hotMineId = mine.id"
      @focusout="hotMineId = null"
    />
  </div>
</template>

<style scoped>
.map-view {
  position: relative;
  overflow: hidden;
  min-height: 100%;
  background: var(--bg-night-bottom);
}
.map-art {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  /* The painting is portrait like the panel, so cover barely crops it. */
  object-fit: cover;
  object-position: 50% 60%;
  user-select: none;
}
.map-vignette {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background:
    radial-gradient(120% 80% at 50% 45%, transparent 40%, #07050380 78%, #070503d9 100%),
    linear-gradient(#0b0906a6, transparent 22%, transparent 62%, #0b0906b3);
}
.map-trails {
  position: absolute;
  /* Above the painting and its vignette, below every mound (z-index 24-76). */
  z-index: 1;
  inset: 0;
  width: 100%;
  height: 100%;
  /* Scenery, never a click target — the mounds own every hit area on the map. */
  pointer-events: none;
}
.map-trail {
  /* Pale dirt worn into the rock, kept faint so it guides without competing
     with the lit mounds. The drop-shadow is the trail's own dark bed, which is
     cheaper and softer than painting a second, wider polyline underneath. */
  stroke: #c9a06859;
  stroke-width: 1.4;
  stroke-linecap: round;
  stroke-linejoin: round;
  /* Long dashes read as a footpath crossing loose ground rather than a drawn line. */
  stroke-dasharray: 7 5;
  fill: none;
  filter: drop-shadow(0 1px 1px #0b090699);
}
.map-empty {
  position: absolute;
  z-index: 2;
  top: 42%;
  left: 50%;
  max-width: 280px;
  margin: 0;
  color: var(--ink-dim);
  font-size: 13px;
  line-height: 1.6;
  text-align: center;
  text-shadow: 0 1px 4px #000;
  translate: -50% -50%;
}
</style>
