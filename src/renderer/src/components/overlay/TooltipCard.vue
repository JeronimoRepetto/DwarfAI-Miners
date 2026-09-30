<script setup lang="ts">
/*
 * The tooltip card (#635), `molecules/tooltip` in the design: the raised wood card the map's and
 * the dwarf's tooltips share, a title (a tier chip before it when the card describes a mine) and
 * rows of facts, each a label and its value. Never a control and never a pointer target. Whoever
 * owns the target decides when it shows and where it goes (lib/overlay/tipCard); a card with a
 * body of its own passes it in the slot.
 */
import TierChip from '../controls/TierChip.vue'
import type { TipRow } from '../../lib/overlay/tipCard'
import type { MineTier } from '../../types'

withDefaults(defineProps<{ title?: string; tier?: MineTier; rows?: TipRow[] }>(), {
  title: undefined,
  tier: undefined,
  rows: () => []
})
</script>

<template>
  <div class="dm-tip m-mat m-raised" role="tooltip">
    <div v-if="title !== undefined" class="dm-tip__title">
      <TierChip v-if="tier !== undefined" :tier="tier" />{{ title }}
    </div>
    <div v-for="row in rows" :key="row.label" class="dm-tip__row" :data-tone="row.tone">
      {{ row.label }}<b>{{ row.value }}</b>
    </div>
    <slot />
  </div>
</template>

<style scoped>
/* The design's tooltip.css, rule for rule. */
.dm-tip {
  --mat-fill: var(--wood);
  --mat-hi: var(--wood-hi);
  --mat-lo: var(--wood-lo);
  --mat-edge: var(--rock-lo);
  display: grid;
  min-width: 140px;
  max-width: 240px;
  position: fixed;
  gap: 4px;
  padding: 8px 10px;
  font: var(--fs-meta) / 1.35 var(--f-meta);
  color: var(--ink-soft);
  z-index: var(--z-overlay);
  pointer-events: none;
}
.dm-tip__title {
  display: flex;
  gap: 6px;
  font-size: var(--fs-section);
  color: var(--parchment);
  align-items: center;
}
.dm-tip__row {
  display: flex;
  gap: 12px;
  justify-content: space-between;
}
.dm-tip__row b {
  font-weight: 400;
  color: var(--ink);
}
/* screens/map.md: a mine that cannot be entered adds "Not enterable" in --warn. */
.dm-tip__row[data-tone='warn'] {
  color: var(--warn);
}
</style>
