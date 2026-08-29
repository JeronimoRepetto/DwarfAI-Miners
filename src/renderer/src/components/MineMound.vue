<script setup lang="ts">
import { computed } from 'vue'
import { tierLabel } from '../lib/presentation'
import type { Mine } from '../types'

const props = defineProps<{ mine: Mine }>()

const emit = defineEmits<{ open: [mineId: string] }>()

const dwarfCount = computed(() => props.mine.dwarfs.length)
const countLabel = computed(
  () => `${dwarfCount.value} ${dwarfCount.value === 1 ? 'dwarf' : 'dwarfs'}`
)
</script>

<template>
  <div class="mine-mound" :data-tier="mine.tier">
    <button
      class="mound-hit"
      type="button"
      :aria-label="`Enter ${mine.name} (${tierLabel(mine.tier)} mine, ${countLabel})`"
      @click="emit('open', mine.id)"
    >
      <svg class="mound-figure" viewBox="0 0 120 92" aria-hidden="true">
        <!-- grounding shadow -->
        <ellipse cx="60" cy="80" rx="46" ry="9" fill="#000" opacity="0.35" />
        <!-- the mound itself -->
        <path class="mound-rock" d="M14 78 Q20 38 60 30 Q100 38 106 78 Z" />
        <path class="mound-light" d="M30 66 Q38 42 60 36 Q50 52 44 72 Z" />
        <!-- copper-only patina streaks -->
        <path class="patina" d="M70 40 Q78 52 74 70 M60 34 Q64 46 60 58" fill="none" />
        <!-- silver-only sheen -->
        <path class="sheen" d="M26 70 Q40 40 62 33" fill="none" />
        <!-- timber-framed entrance -->
        <path d="M42 78 Q42 56 60 56 Q78 56 78 78 Z" fill="#0d0906" />
        <rect x="39" y="56" width="5" height="22" fill="#6b4a2a" />
        <rect x="76" y="56" width="5" height="22" fill="#6b4a2a" />
        <rect x="38" y="52" width="44" height="6" rx="2" fill="#7a5533" />
        <!-- lantern by the door -->
        <circle class="lantern-glow" cx="84" cy="62" r="7" />
        <circle cx="84" cy="62" r="2.4" fill="#ffdf94" />
        <!-- mineral crystals in the tier palette -->
        <circle class="crystal-glow" cx="34" cy="46" r="9" />
        <circle class="crystal-glow" cx="88" cy="44" r="8" />
        <polygon class="crystal" points="30,50 34,38 38,50" />
        <polygon class="crystal" points="84,48 88,38 92,48" />
        <polygon class="crystal" points="58,26 62,16 66,26" />
        <circle class="crystal-glow" cx="62" cy="22" r="8" />
      </svg>
      <span class="mound-count" aria-hidden="true">{{ dwarfCount }}</span>
      <span class="mound-name">{{ mine.name }}</span>
    </button>
    <div class="mine-tooltip" role="tooltip">
      <strong>{{ mine.name }}</strong>
      <em>{{ tierLabel(mine.tier) }} mine</em>
      <span class="tooltip-path">{{ mine.path }}</span>
      <span>{{ countLabel }} inside</span>
    </div>
  </div>
</template>

<style scoped>
.mine-mound {
  position: absolute;
  width: 108px;
  translate: -50% -60%;
}
.mound-hit {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
  padding: 0;
  border: 0;
  cursor: pointer;
  background: transparent;
}
.mound-hit:focus-visible {
  outline: 2px solid #ffe29c;
  outline-offset: 3px;
  border-radius: 10px;
}
.mound-figure {
  display: block;
  width: 100%;
  overflow: visible;
  transition: transform 0.18s ease-out;
}
.mound-hit:hover .mound-figure {
  transform: translateY(-3px);
}
.mound-rock {
  fill: var(--tier-deep);
  stroke: color-mix(in srgb, var(--tier-accent) 40%, #241a10);
  stroke-width: 1.5;
}
.mound-light {
  fill: var(--tier-mid);
  opacity: 0.65;
}
.crystal {
  fill: var(--tier-accent);
}
.crystal-glow {
  fill: var(--tier-glow);
  transform-box: fill-box;
  transform-origin: center;
}
.lantern-glow {
  fill: #f6b644;
  opacity: 0.24;
  animation: lantern-breathe 4s ease-in-out infinite;
}
.patina,
.sheen {
  display: none;
}
[data-tier='copper'] .patina {
  display: block;
  stroke: var(--tier-accent);
  stroke-width: 2;
  opacity: 0.5;
}
[data-tier='silver'] .sheen {
  display: block;
  stroke: var(--tier-accent);
  stroke-width: 1.6;
  stroke-dasharray: 8 46;
  opacity: 0.7;
  animation: sheen-slide 5s linear infinite;
}
[data-tier='gold'] .mound-figure {
  filter: drop-shadow(0 0 7px var(--tier-glow));
}
[data-tier='uranium'] .mound-rock {
  fill: #131a12;
}
[data-tier='uranium'] .crystal-glow {
  animation: glow-pulse 2.8s ease-in-out infinite;
}
[data-tier='uranium'] .mound-figure {
  filter: drop-shadow(0 0 9px var(--tier-glow));
}
.mound-count {
  position: absolute;
  top: 2px;
  right: 8px;
  display: grid;
  place-items: center;
  min-width: 18px;
  height: 18px;
  padding: 0 4px;
  border: 1px solid var(--tier-accent);
  border-radius: 9px;
  color: var(--ink);
  background: #15100be6;
  font-size: 10px;
}
.mound-name {
  max-width: 104px;
  margin-top: 1px;
  overflow: hidden;
  color: var(--ink-dim);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mine-tooltip {
  position: absolute;
  z-index: 50;
  bottom: calc(100% + 4px);
  left: 50%;
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: max-content;
  max-width: 200px;
  padding: 7px 9px;
  border: 1px solid var(--line-strong);
  border-radius: 7px;
  color: var(--ink);
  background: #15100bf2;
  box-shadow: 0 4px 14px #000a;
  font-size: 10px;
  line-height: 1.3;
  text-align: left;
  opacity: 0;
  pointer-events: none;
  translate: -50% 0;
  transition: opacity 0.15s;
}
.mine-tooltip strong {
  font-size: 11px;
}
.mine-tooltip em {
  color: var(--tier-accent);
  font-style: normal;
  font-size: 9px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.tooltip-path {
  overflow: hidden;
  max-width: 190px;
  color: var(--ink-faint);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mound-hit:hover ~ .mine-tooltip,
.mound-hit:focus-visible ~ .mine-tooltip {
  opacity: 1;
}
@keyframes lantern-breathe {
  50% {
    opacity: 0.42;
  }
}
@keyframes glow-pulse {
  50% {
    opacity: 0.35;
    transform: scale(1.25);
  }
}
@keyframes sheen-slide {
  to {
    stroke-dashoffset: -54;
  }
}
</style>
