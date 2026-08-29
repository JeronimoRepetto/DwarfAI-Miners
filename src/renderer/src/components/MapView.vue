<script setup lang="ts">
import { computed } from 'vue'
import { MAP_BG_SRC } from '../lib/art'
import { MAP_SLOTS, assignSlots } from '../lib/placement'
import type { Mine } from '../types'
import MineMound from './MineMound.vue'
import VaultChip from './VaultChip.vue'

const props = withDefaults(defineProps<{ mines: Mine[]; tokensObserved?: number }>(), {
  tokensObserved: 0
})

const emit = defineEmits<{ open: [mineId: string] }>()

const slotByMine = computed(() => assignSlots(props.mines.map((mine) => mine.id)))

function positionStyle(mineId: string): Record<string, string> {
  const slot = MAP_SLOTS[slotByMine.value.get(mineId) ?? 0] ?? { x: 50, y: 50 }
  return { left: `${slot.x}%`, top: `${slot.y}%`, zIndex: `${Math.round(slot.y)}` }
}
</script>

<template>
  <div class="map-view" aria-label="Isometric map of active mines">
    <img class="map-art" :src="MAP_BG_SRC" alt="" aria-hidden="true" draggable="false" />
    <!-- Darkens the edges and the valley floor so the lit mounds carry the eye. -->
    <div class="map-vignette" aria-hidden="true"></div>
    <VaultChip :tokens-observed="tokensObserved" />
    <p v-if="mines.length === 0" class="map-empty">
      The hills are quiet.<br />
      No agents are mining right now — start a coding session and a mine will appear.
    </p>
    <MineMound
      v-for="mine in mines"
      :key="mine.id"
      :mine="mine"
      :style="positionStyle(mine.id)"
      @open="emit('open', $event)"
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
