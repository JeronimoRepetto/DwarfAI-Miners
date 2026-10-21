<script setup lang="ts">
/*
 * A Veta chamber's mine tab (`DS/docs/components.md`, Mine tab; `DS/docs/screens/veta.md` V1b; 07 machine 23;
 * US-VETA-004.AC03, AC04, AC08; ISSUE-289): the mine's handle, a small raised wood plate holding its tier chip, its full
 * name, "▢" to open the Panel on it and "+" to send a new dwarf in. Both buttons are icon-only, named with the mine's
 * full name. Presentational: the chamber places it and raises it, and its container acts on `open` and `add`.
 */
import { t, type MineWire } from '@dwarfai/contracts'
import { computed } from 'vue'
import type { MineTier } from '../../types'
import ActionButton from '../controls/ActionButton.vue'
import TierChip from '../controls/TierChip.vue'

const props = defineProps<{ mine: Pick<MineWire, 'id' | 'name' | 'tier'> }>()

const emit = defineEmits<{
  /** "▢": the Panel on this mine. */
  open: []
  /** "+": the Add panel aimed at this mine. */
  add: []
}>()

/** A mine not measured yet is drawn on bronze, as its chamber is. */
const tier = computed<MineTier>(() => props.mine.tier ?? 'bronze')
</script>

<template>
  <div class="veta-minetab m-mat m-raised" :data-mine-id="mine.id" data-veta-mine-tab>
    <TierChip :tier="tier" />
    <span class="veta-minetab__name" data-tab-name>{{ mine.name }}</span>
    <span class="veta-minetab__tools">
      <ActionButton
        icon="promote"
        size="sm"
        :title="t('veta.tab.open', { name: mine.name })"
        data-tab-open
        @click="emit('open')"
      />
      <ActionButton
        icon="add"
        size="sm"
        :title="t('veta.tab.newDwarf', { name: mine.name })"
        data-tab-add
        @click="emit('add')"
      />
    </span>
  </div>
</template>

<style scoped>
/* `.dm-minetab`: a 40 px raised wood plate, its row on one line. */
.veta-minetab {
  --mat-fill: var(--wood);
  --mat-hi: var(--wood-hi);
  --mat-lo: var(--wood-lo);
  --mat-edge: var(--rock-lo);
  --tab-h: 40px;
  display: flex;
  align-items: center;
  gap: 6px;
  box-sizing: border-box;
  height: var(--tab-h);
  padding: 0 2px 0 8px;
  white-space: nowrap;
}

.veta-minetab__name {
  font: 400 var(--fs-section) / 1 var(--f-label);
  color: var(--parchment);
}

.veta-minetab__tools {
  display: flex;
  align-items: center;
}
</style>
