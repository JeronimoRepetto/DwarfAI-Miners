<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
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
      <!-- layered depth: three parallax planes drifting at different speeds -->
      <svg
        class="layer layer-back"
        viewBox="0 0 480 300"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <rect width="480" height="300" fill="#171009" />
        <path
          d="M0 40 Q90 86 180 48 Q290 12 360 58 Q430 96 480 52 L480 300 L0 300 Z"
          fill="#1d150c"
        />
        <path
          class="vein vein-dim"
          d="M60 80 Q110 130 90 210 M300 40 Q340 120 320 220 M420 90 Q400 160 440 240"
          fill="none"
        />
      </svg>
      <svg
        class="layer layer-mid"
        viewBox="0 0 480 300"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path d="M-20 0 Q30 90 8 300 L-20 300 Z" fill="#241a0f" />
        <path d="M500 0 Q450 100 472 300 L500 300 Z" fill="#241a0f" />
        <path d="M120 0 L150 0 Q138 46 158 78 Q128 66 120 0 Z" fill="#20170d" />
        <path d="M330 0 L362 0 Q356 58 372 92 Q338 74 330 0 Z" fill="#20170d" />
        <path
          class="vein"
          d="M40 140 Q90 180 70 260 M200 90 Q250 160 230 270 M400 120 Q370 190 410 268"
          fill="none"
        />
        <polygon class="crystal" points="66,258 74,236 84,258" />
        <polygon class="crystal" points="226,266 236,240 248,266" />
        <polygon class="crystal" points="404,262 412,242 422,262" />
        <circle class="crystal-glow" cx="75" cy="250" r="13" />
        <circle class="crystal-glow" cx="237" cy="256" r="15" />
        <circle class="crystal-glow" cx="413" cy="254" r="12" />
      </svg>
      <svg
        class="layer layer-front"
        viewBox="0 0 480 300"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path d="M0 262 Q120 250 240 258 Q360 266 480 256 L480 300 L0 300 Z" fill="#100a06" />
        <polygon points="10,300 34,236 62,300" fill="#150d07" />
        <polygon points="430,300 452,244 480,300" fill="#150d07" />
        <circle class="lantern-glow" cx="52" cy="70" r="16" />
        <circle cx="52" cy="70" r="4" fill="#ffdf94" />
        <rect x="50" y="52" width="4" height="12" fill="#54401f" />
      </svg>

      <!-- idle mine: tools against the wall -->
      <div v-if="mine.dwarfs.length === 0" class="mine-idle">
        <svg class="idle-tools" viewBox="0 0 90 70" aria-hidden="true">
          <rect
            x="30"
            y="12"
            width="4"
            height="50"
            rx="2"
            fill="#8a6538"
            transform="rotate(14 32 37)"
          />
          <path d="M12 18 Q30 4 48 18 Q30 12 12 18 Z" fill="#9aa3ad" />
          <rect
            x="56"
            y="14"
            width="4"
            height="48"
            rx="2"
            fill="#8a6538"
            transform="rotate(-12 58 38)"
          />
          <path d="M48 12 Q58 2 68 12 L64 24 Q58 18 52 24 Z" fill="#9aa3ad" />
          <ellipse cx="45" cy="64" rx="34" ry="5" fill="#000" opacity="0.4" />
        </svg>
        <p>Nobody is working this mine yet.</p>
      </div>

      <!-- the crew -->
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
  min-height: 300px;
  border: 1px solid var(--line-soft);
  border-radius: 14px;
  background: #171009;
  box-shadow: inset 0 0 48px #000c;
}
.layer {
  position: absolute;
  inset: -3% 0;
  width: 100%;
  height: 106%;
}
.layer-back {
  animation: drift 36s ease-in-out infinite alternate;
}
.layer-mid {
  animation: drift 26s ease-in-out infinite alternate-reverse;
}
.layer-front {
  animation: drift 20s ease-in-out infinite alternate;
  pointer-events: none;
}
.vein {
  stroke: var(--tier-accent);
  stroke-width: 2.4;
  stroke-linecap: round;
  opacity: 0.4;
  animation: vein-shimmer 6s ease-in-out infinite;
}
.vein-dim {
  stroke-width: 1.8;
  opacity: 0.16;
  animation: none;
}
.crystal {
  fill: var(--tier-accent);
}
.crystal-glow {
  fill: var(--tier-glow);
  animation: glow-breathe 4.5s ease-in-out infinite;
}
.lantern-glow {
  fill: #f6b644;
  opacity: 0.2;
  animation: glow-breathe 3.6s ease-in-out infinite;
}
.mine-idle {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: var(--ink-dim);
  font-size: 13px;
  text-align: center;
}
.idle-tools {
  width: 84px;
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
  padding: 0 10px 8px;
}
.foreman-post {
  display: flex;
  gap: 4px;
  padding-right: 10px;
  padding-bottom: 14px;
  border-right: 1px dashed #f4ead81f;
}
.crew {
  display: flex;
  flex: 1;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: center;
  gap: 2px 8px;
  min-height: 108px;
}
@keyframes drift {
  to {
    transform: translateX(9px);
  }
}
@keyframes vein-shimmer {
  50% {
    opacity: 0.7;
  }
}
@keyframes glow-breathe {
  50% {
    opacity: 0.5;
  }
}
</style>
