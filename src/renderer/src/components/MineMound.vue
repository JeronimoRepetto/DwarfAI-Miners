<script setup lang="ts">
import { computed } from 'vue'
import { MOUND_SRC } from '../lib/art'
import { tierLabel } from '../lib/presentation'
import type { Mine } from '../types'

const props = defineProps<{ mine: Mine }>()

const emit = defineEmits<{ open: [mineId: string] }>()

const dwarfCount = computed(() => props.mine.dwarfs.length)
const countLabel = computed(
  () => `${dwarfCount.value} ${dwarfCount.value === 1 ? 'dwarf' : 'dwarfs'}`
)
const moundSrc = computed(() => MOUND_SRC[props.mine.tier])
</script>

<template>
  <div class="mine-mound" :data-tier="mine.tier">
    <button
      class="mound-hit"
      type="button"
      :aria-label="`Enter ${mine.name} (${tierLabel(mine.tier)} mine, ${countLabel})`"
      @click="emit('open', mine.id)"
    >
      <img class="mound-art" :src="moundSrc" alt="" aria-hidden="true" draggable="false" />
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
  width: 116px;
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
.mound-art {
  display: block;
  width: 100%;
  height: auto;
  /* Grounding shadow, since the painting itself is cut out of its backdrop. */
  filter: drop-shadow(0 5px 6px #000000b3);
  transition: transform 0.18s ease-out;
  user-select: none;
}
.mound-hit:hover .mound-art {
  transform: translateY(-3px);
}
/* The richest tiers keep the faint aura the old vector mounds had. */
[data-tier='gold'] .mound-art {
  filter: drop-shadow(0 5px 6px #000000b3) drop-shadow(0 0 8px var(--tier-glow));
}
[data-tier='uranium'] .mound-art {
  filter: drop-shadow(0 5px 6px #000000b3) drop-shadow(0 0 10px var(--tier-glow));
  animation: tier-pulse 3.2s ease-in-out infinite;
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
  max-width: 112px;
  margin-top: 1px;
  overflow: hidden;
  color: var(--ink-dim);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-shadow: 0 1px 3px #000;
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
@keyframes tier-pulse {
  50% {
    filter: drop-shadow(0 5px 6px #000000b3) drop-shadow(0 0 16px var(--tier-glow));
  }
}
</style>
