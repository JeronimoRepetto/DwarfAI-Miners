<script setup lang="ts">
/*
 * The Control room's main zone (`DS/docs/screens/valle.md` VA1, Layout; 07 machine 28 `control`, S32.02; ISSUE-300):
 * the mosaic of mine columns in the restored order, four across and scrolling sideways past four. Each column's content,
 * the add slot and the first mosaic are their issues' (ISSUE-302…ISSUE-304); here a column is its mine's place.
 */
import type { MineId } from '@dwarfai/contracts'

defineProps<{
  /** The mosaic's columns in order, each with its mine's name. */
  columns: readonly { mineId: MineId; name: string }[]
}>()
</script>

<template>
  <div class="dm-valle__main" data-page="mines">
    <div class="dm-vmines" role="region" aria-label="Mines">
      <section
        v-for="column in columns"
        :key="column.mineId"
        class="dm-vz"
        :data-valle-column="column.mineId"
        :aria-label="`Mine ${column.name}`"
      ></section>
    </div>
  </div>
</template>

<style scoped>
.dm-valle__main {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  min-width: 0;
  min-height: 0;
}
.dm-vmines {
  --col-w: calc((100% - 18px) / 4);
  display: flex;
  gap: 6px;
  min-width: 0;
  min-height: 0;
  overflow-x: auto;
}
.dm-vz {
  flex: 0 0 max(232px, var(--col-w));
}
</style>
