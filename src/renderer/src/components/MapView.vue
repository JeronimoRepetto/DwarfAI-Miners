<script setup lang="ts">
import { computed } from 'vue'
import { MAP_SLOTS, assignSlots } from '../lib/placement'
import type { Mine } from '../types'
import MineMound from './MineMound.vue'

const props = defineProps<{ mines: Mine[] }>()

const emit = defineEmits<{ open: [mineId: string] }>()

const slotByMine = computed(() => assignSlots(props.mines.map((mine) => mine.id)))

function positionStyle(mineId: string): Record<string, string> {
  const slot = MAP_SLOTS[slotByMine.value.get(mineId) ?? 0] ?? { x: 50, y: 50 }
  return { left: `${slot.x}%`, top: `${slot.y}%`, zIndex: `${Math.round(slot.y)}` }
}
</script>

<template>
  <div class="map-view" aria-label="Isometric map of active mines">
    <svg class="map-terrain" viewBox="0 0 460 480" preserveAspectRatio="none" aria-hidden="true">
      <!-- night sky -->
      <circle class="star" cx="40" cy="34" r="1.4" />
      <circle class="star star-slow" cx="120" cy="18" r="1.1" />
      <circle class="star" cx="210" cy="42" r="1.5" />
      <circle class="star star-slow" cx="300" cy="22" r="1.2" />
      <circle class="star" cx="382" cy="38" r="1.4" />
      <circle class="star star-slow" cx="430" cy="60" r="1" />
      <circle class="star" cx="70" cy="64" r="1" />
      <circle class="star star-slow" cx="255" cy="12" r="1" />
      <circle cx="396" cy="52" r="13" fill="#e8dfc8" opacity="0.85" />
      <circle cx="391" cy="47" r="12" fill="#171a26" />
      <!-- distant ridge -->
      <path
        d="M0 118 L70 84 L128 112 L196 74 L268 116 L330 82 L400 114 L460 92 L460 480 L0 480 Z"
        fill="#181510"
      />
      <!-- isometric ground plane -->
      <polygon points="230,96 460,212 230,470 0,212" fill="#20261a" />
      <polygon points="230,96 460,212 230,328 0,212" fill="#242c1e" opacity="0.55" />
      <g stroke="#f4ead8" stroke-width="1" opacity="0.05">
        <path d="M115 154 L345 270 M58 183 L288 299 M172 125 L402 241" fill="none" />
        <path d="M345 154 L115 270 M402 183 L172 299 M288 125 L58 241" fill="none" />
      </g>
      <!-- scattered rocks and pines -->
      <polygon points="52,262 62,246 74,262" fill="#11150d" />
      <polygon points="410,246 420,228 432,246" fill="#11150d" />
      <polygon points="398,252 406,240 416,252" fill="#161b11" />
      <ellipse cx="96" cy="300" rx="12" ry="5" fill="#161b11" />
      <ellipse cx="368" cy="312" rx="10" ry="4" fill="#161b11" />
      <!-- drifting valley fog -->
      <ellipse class="fog fog-a" cx="140" cy="330" rx="120" ry="24" />
      <ellipse class="fog fog-b" cx="330" cy="250" rx="110" ry="20" />
    </svg>
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
  background: linear-gradient(var(--bg-night-top), #12100c 40%, var(--bg-night-bottom));
}
.map-terrain {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
.star {
  fill: #f4ead8;
  opacity: 0.7;
  animation: twinkle 3.4s ease-in-out infinite;
}
.star-slow {
  animation-duration: 5.2s;
  animation-delay: 1.3s;
}
.fog {
  fill: #9fb2c9;
  opacity: 0.05;
}
.fog-a {
  animation: fog-drift 26s ease-in-out infinite alternate;
}
.fog-b {
  animation: fog-drift 34s ease-in-out infinite alternate-reverse;
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
  translate: -50% -50%;
}
@keyframes twinkle {
  50% {
    opacity: 0.2;
  }
}
@keyframes fog-drift {
  to {
    transform: translateX(26px);
  }
}
</style>
