<script setup lang="ts">
/*
 * The Panel's Map page or Mines list, hosted in a Valle zone or over Valle's main zone (07 S31.03, S31.04, S28.19;
 * US-VALLE-009.AC01; ISSUE-304): the same components, fed from the window's own board and page parts (`VALLE_PAGES`,
 * the composables the Panel's shell uses), sized to what holds them.
 *
 * Opening a mine is the holder's (`open`): a zone's map marker goes back to the mines (S31.10), a mine opened from a
 * list or a nav page joins the mosaic or swaps into the Work front (S32.14, S28.15). A refusal and an add are the Mines
 * page's own, said and run as in the Panel.
 */
import { inject } from 'vue'
import MinesList from '../browse/MinesList.vue'
import MapPage from '../map/MapPage.vue'
import { VALLE_PAGES } from './valleZones'

defineProps<{ page: 'map' | 'mines' }>()
const emit = defineEmits<{ open: [mineId: string] }>()

const pages = inject(VALLE_PAGES)
if (pages === undefined) throw new Error('ValleHostedPage needs the Valle root (VALLE_PAGES)')
const { board, map, mines } = pages
</script>

<template>
  <div class="dm-vhosted" :data-valle-hosted="page">
    <MapPage
      v-if="page === 'map'"
      :mines="board.mines"
      :projects="mines.projects.value"
      :materials="board.materials"
      :open-id="null"
      :variant="map.variant.value"
      :adding="mines.adding.value"
      :loading="map.loading.value"
      @open="(mineId) => emit('open', mineId)"
      @refuse="mines.refuse"
      @add="mines.add"
    />
    <MinesList
      v-else
      :cards="mines.mineCards.value"
      :open-id="null"
      :search="mines.filters.value.search"
      :tier="mines.filters.value.tier"
      :sort="mines.filters.value.sort"
      :loading="mines.loading.value"
      :error="mines.error.value"
      :adding="mines.adding.value"
      :add-error="mines.addError.value"
      :removing="mines.removing.value"
      :remove-error="mines.removeError.value"
      :worktree-question="mines.worktreeQuestion.value"
      :reveal-id="mines.reveal.value"
      @search="mines.setSearch"
      @tier="mines.setTier"
      @sort="mines.sort"
      @add="mines.add"
      @open="(mineId) => emit('open', mineId)"
      @refuse="mines.refuse"
      @remove="mines.remove"
      @open-main-project="mines.adoptMainProject"
      @dismiss-worktree="mines.dismissWorktreeQuestion"
    />
  </div>
</template>

<style scoped>
.dm-vhosted {
  display: grid;
  grid-template: minmax(0, 1fr) / minmax(0, 1fr);
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: auto;
}
</style>
