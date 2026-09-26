<script setup lang="ts">
/*
 * The page header plate (#635), `organisms/page-header` in the design: the page's title, and its
 * actions at the far end, on one wood plate at one height. Only the title and the actions slot so
 * far — the guild pages need no more; search, sort and add arrive with the Mines page's slice.
 */
defineProps<{ title: string }>()
</script>

<template>
  <header class="dm-phead m-mat">
    <h1 class="dm-phead__title">{{ title }}</h1>
    <span class="dm-phead__grow"></span>
    <div class="dm-phead__actions"><slot /></div>
  </header>
</template>

<style scoped>
/* The design's page-header.css, rule for rule, for the parts drawn so far. */
.dm-phead {
  --mat-fill: var(--wood);
  --mat-hi: var(--wood-hi);
  --mat-lo: var(--wood-lo);
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 2px;
  padding: 6px 6px 6px 12px;
}
.dm-phead__title {
  margin: 0 4px 0 0;
  font: var(--fs-title) / 1 var(--f-display);
  color: var(--gold);
  white-space: nowrap;
}
.dm-phead__grow {
  flex: 1;
}
.dm-phead__actions {
  display: flex;
  gap: 2px;
}
</style>
