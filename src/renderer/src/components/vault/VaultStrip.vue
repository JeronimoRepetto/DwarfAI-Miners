<script setup lang="ts">
/*
 * The vault strip (#635), `molecules/vault-strip` in the design: a row of ore capsules, a mine's
 * footer or, on a wood plate with its label, the map's totals. A group named "Ore" (or its label);
 * every capsule names its material and full count. With every counter at zero it reads
 * "No ore yet". What it keeps is lib/vault/vaultStrip's; units are never summed across materials.
 */
import { computed } from 'vue'
import OreCapsule from './OreCapsule.vue'
import {
  VAULT_EMPTY,
  vaultStripClasses,
  vaultStripOre,
  type VaultStripOre
} from '../../lib/vault/vaultStrip'
import type { OreCapsuleSize } from '../../lib/vault/oreCapsule'

const props = withDefaults(
  defineProps<{
    ore: VaultStripOre[]
    label?: string
    plate?: boolean
    size?: OreCapsuleSize
    /** Keeps only this many of the richest materials, for a narrow strip. */
    max?: number
  }>(),
  { label: undefined, plate: false, size: undefined, max: undefined }
)

const shown = computed(() => vaultStripOre(props.ore, props.max))
const classes = computed(() => vaultStripClasses(props.plate))
</script>

<template>
  <div :class="classes" role="group" :aria-label="label ?? 'Ore'">
    <span v-if="label !== undefined" class="dm-vault__label">{{ label }}</span>
    <OreCapsule
      v-for="row in shown"
      :key="row.material"
      :material="row.material"
      :units="row.units"
      :size="size"
    />
    <span v-if="shown.length === 0" class="dm-vault__empty">{{ VAULT_EMPTY }}</span>
  </div>
</template>

<style scoped>
/* The design's vault-strip.css, rule for rule. */
.dm-vault {
  display: flex;
  min-width: 0;
  gap: 2px;
  align-items: center;
  overflow: hidden;
}
.dm-vault--plate {
  padding: 4px 6px;
  flex-wrap: wrap;
}
.dm-vault__label {
  margin-right: 4px;
  font: var(--fs-meta) / 1 var(--f-meta);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--ink-faint);
}
.dm-vault__empty {
  font: var(--fs-meta) / 1 var(--f-meta);
  color: var(--ink-faint);
}
</style>
