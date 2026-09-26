<script setup lang="ts">
/*
 * The redesigned ore capsule (#635), `atoms/ore` in the design: one material's nugget art and its
 * compact count, named in full ("Gold: 12,480") so the compact number is never the only reading.
 * The nugget art is the material's colour; no token colours an ore. Beside NuggetPile, which
 * heaps nuggets in the cave, not a replacement for it. What it shows is lib/vault/oreCapsule's.
 */
import { computed } from 'vue'
import { NUGGET_SRC } from '../../lib/art'
import {
  compactUnits,
  oreCapsuleClasses,
  oreCapsuleName,
  type OreCapsuleSize
} from '../../lib/vault/oreCapsule'
import type { Material } from '../../types'

const props = defineProps<{ material: Material; units: number; size?: OreCapsuleSize }>()

const classes = computed(() => oreCapsuleClasses(props.units, props.size))
const name = computed(() => oreCapsuleName(props.material, props.units))
</script>

<template>
  <span :class="classes" :title="name" :aria-label="name">
    <img :src="NUGGET_SRC[material]" alt="" />
    <span>{{ compactUnits(units) }}</span>
  </span>
</template>

<style scoped>
/* The design's ore.css, rule for rule and in its order. */
.dm-ore {
  display: inline-flex;
  height: 22px;
  gap: 4px;
  padding: 0 6px 0 4px;
  margin: var(--px);
  font: var(--fs-meta) / 1 var(--f-meta);
  color: var(--ink);
  background: var(--rock);
  box-shadow:
    0 -2px 0 0 var(--rock-lo),
    0 2px 0 0 var(--rock-lo),
    -2px 0 0 0 var(--rock-lo),
    2px 0 0 0 var(--rock-lo),
    inset 2px 2px 0 0 var(--rock-lo);
  align-items: center;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.dm-ore img {
  width: 18px;
  height: 16px;
  object-fit: contain;
}
.dm-ore--lg {
  height: 28px;
  font-size: var(--fs-section);
}
.dm-ore--lg img {
  width: 24px;
  height: 22px;
}
.dm-ore--zero {
  color: var(--ink-faint);
}
.dm-ore--zero img {
  opacity: 0.4;
}
</style>
