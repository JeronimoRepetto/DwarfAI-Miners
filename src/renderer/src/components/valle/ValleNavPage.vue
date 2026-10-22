<script setup lang="ts">
/*
 * A nav page over Valle's main zone (07 S28.19, S28.20; UC-069; ISSUE-300): Map, Mines or Settings takes the main zone
 * while the top bar, the nav, the chat zone and the needs-you queue stay where they are; Esc with no other layer open
 * returns to the preset beneath. Each draws the Panel's own page in its `default` slot (ISSUE-304): Map and Mines
 * (`ValleHostedPage`), and Settings without its Panel-window rows (`ValleSettingsPage`; owner decision 2026-10-22).
 */
import { computed } from 'vue'
import type { ValleNavPage } from '../../lib/valle/preset'

const props = defineProps<{ page: ValleNavPage }>()

const LABELS: Readonly<Record<ValleNavPage, string>> = {
  map: 'Map',
  mines: 'Mines',
  settings: 'Settings'
}
const label = computed(() => LABELS[props.page])
</script>

<template>
  <section class="dm-valle__main dm-valle__page" :data-valle-page="page" :aria-label="label">
    <slot />
  </section>
</template>

<style scoped>
.dm-valle__page {
  display: grid;
  grid-template: minmax(0, 1fr) / minmax(0, 1fr);
  min-width: 0;
  min-height: 0;
}
</style>
