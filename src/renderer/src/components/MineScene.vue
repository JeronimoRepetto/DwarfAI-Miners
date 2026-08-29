<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { INTERIOR_SRC } from '../lib/art'
import { createBubbleBoard } from '../lib/bubbles'
import { tierLabel } from '../lib/presentation'
import type { Dwarf, Mine } from '../types'
import DwarfSprite from './DwarfSprite.vue'

const props = defineProps<{
  mine: Mine
  activatingId?: string | null
}>()

const emit = defineEmits<{ back: []; activate: [dwarf: Dwarf] }>()

const foremen = computed(() => props.mine.dwarfs.filter((dwarf) => dwarf.role === 'foreman'))
const workers = computed(() => props.mine.dwarfs.filter((dwarf) => dwarf.role !== 'foreman'))
const interiorSrc = computed(() => INTERIOR_SRC[props.mine.tier])

const bubbles = ref<ReadonlyMap<string, string>>(new Map())
const board = createBubbleBoard((visible) => {
  bubbles.value = visible
})
watch(
  () => props.mine.dwarfs,
  (dwarfs) => board.sync(dwarfs),
  { immediate: true }
)
onBeforeUnmount(() => board.dispose())
</script>

<template>
  <section class="mine-scene" :data-tier="mine.tier" aria-labelledby="mine-title">
    <header class="scene-header">
      <button class="back-button" type="button" aria-label="Back to the map" @click="emit('back')">
        &larr; Map
      </button>
      <div class="scene-heading">
        <h1 id="mine-title">{{ mine.name }}</h1>
        <p class="scene-path">{{ mine.path }}</p>
      </div>
      <span class="tier-badge">{{ tierLabel(mine.tier) }}</span>
    </header>

    <div class="cave">
      <img class="cave-art" :src="interiorSrc" alt="" aria-hidden="true" draggable="false" />
      <!-- Keeps the crew readable against a busy painting. -->
      <div class="cave-vignette" aria-hidden="true"></div>

      <!-- idle mine: nobody on the floor -->
      <div v-if="mine.dwarfs.length === 0" class="mine-idle">
        <p>Nobody is working this mine yet.</p>
      </div>

      <!-- the crew, standing on the walkable band the painting leaves at the bottom -->
      <div v-else class="crew-floor">
        <div v-if="foremen.length" class="foreman-post">
          <DwarfSprite
            v-for="dwarf in foremen"
            :key="dwarf.id"
            :dwarf="dwarf"
            :bubble-text="bubbles.get(dwarf.id)"
            :activating="activatingId === dwarf.id"
            @activate="emit('activate', dwarf)"
          />
        </div>
        <div class="crew">
          <DwarfSprite
            v-for="dwarf in workers"
            :key="dwarf.id"
            :dwarf="dwarf"
            :bubble-text="bubbles.get(dwarf.id)"
            :activating="activatingId === dwarf.id"
            @activate="emit('activate', dwarf)"
          />
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.mine-scene {
  display: flex;
  flex-direction: column;
  min-height: 100%;
  padding: 14px 16px 16px;
}
.scene-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}
.back-button {
  -webkit-app-region: no-drag;
  padding: 6px 9px;
  border: 1px solid var(--line-soft);
  border-radius: 7px;
  color: var(--ink-dim);
  cursor: pointer;
  background: transparent;
  font-size: 12px;
  white-space: nowrap;
}
.back-button:hover {
  color: #fff;
  background: #4b3c28;
}
.back-button:focus-visible {
  outline: 2px solid #ffe29c;
  outline-offset: 2px;
}
.scene-heading {
  flex: 1;
  min-width: 0;
}
.scene-heading h1 {
  overflow: hidden;
  margin: 0;
  font-size: 18px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.scene-path {
  overflow: hidden;
  margin: 2px 0 0;
  color: var(--ink-faint);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tier-badge {
  padding: 4px 9px;
  border: 1px solid var(--tier-accent);
  border-radius: 999px;
  color: var(--tier-accent);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  text-shadow: 0 0 8px var(--tier-glow);
}
.cave {
  position: relative;
  flex: 1;
  overflow: hidden;
  min-height: 320px;
  border: 1px solid var(--line-soft);
  border-radius: 14px;
  background: #171009;
  box-shadow: inset 0 0 48px #000c;
}
.cave-art {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  /*
   * Anchored to the bottom: the painted floor the dwarfs stand on lives in the
   * lowest band of the artwork and must never be the part that gets cropped.
   */
  object-position: 50% 100%;
  user-select: none;
}
.cave-vignette {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background:
    radial-gradient(110% 70% at 50% 40%, transparent 45%, #0a06034d 80%, #0a060399 100%),
    linear-gradient(transparent 55%, #0a0603a6);
}
.mine-idle {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--ink-dim);
  font-size: 13px;
  text-align: center;
  text-shadow: 0 1px 4px #000;
}
.mine-idle p {
  margin: 0;
}
.crew-floor {
  position: absolute;
  inset: auto 0 0;
  z-index: 2;
  display: flex;
  align-items: flex-end;
  gap: 4px;
  /* Sits the crew on the walkable band along the bottom of the painting. */
  padding: 0 8px 4%;
}
.foreman-post {
  display: flex;
  gap: 4px;
  padding-right: 8px;
  padding-bottom: 10px;
  border-right: 1px dashed #f4ead81f;
}
.crew {
  display: flex;
  flex: 1;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: center;
  gap: 2px 4px;
  min-height: 118px;
}
</style>
