<script setup lang="ts">
/*
 * A mine's history hosted in a Valle zone (07 S31.05, S31.11; US-VALLE-009.AC01; US-MINE-006; ISSUE-304): the Panel's
 * own history panel, fed by the same composable (`useMineHistoryPage`) over a store of the zone's own
 * (`createMineHistory`), so two zones showing two mines' histories never share one. The mine is drawn from the window's
 * board and remembered projects (`columnMine`), as the Panel draws the mine it holds open.
 *
 * - Its own close (and Esc inside it) shows the zone's mine again (S31.06); the Esc stops there, never leaving the
 *   Work front or a page beneath (NFR-A11Y-02).
 * - Accepted difference (ISSUE-304): no failed sends are marked until Valle hosts chats; the Panel's come from its
 *   message dock.
 */
import type { MineId } from '@dwarfai/contracts'
import { computed, inject } from 'vue'
import { useMineHistoryPage } from '../../composables/useMineHistoryPage'
import { createMineHistory } from '../../composables/useMineHistory'
import { columnMine } from '../../lib/browse/columnMine'
import HistoryPanel from '../history/HistoryPanel.vue'
import { VALLE_PAGES } from './valleZones'

const props = defineProps<{ mineId: MineId }>()
const emit = defineEmits<{ close: [] }>()

const pages = inject(VALLE_PAGES)
if (pages === undefined) throw new Error('ValleZoneHistory needs the Valle root (VALLE_PAGES)')
const { board, mines } = pages

const mine = computed(() => columnMine(props.mineId, board.mines, mines.projects.value))
const { history, pathRefusal, openPath, openLink } = useMineHistoryPage({
  mineId: () => props.mineId,
  mine: () => mine.value,
  open: () => true,
  store: createMineHistory()
})

function escape(event: KeyboardEvent): void {
  // The panel closes itself on Esc; the press stops here.
  event.preventDefault()
}
</script>

<template>
  <div class="dm-vhosted" data-valle-hosted="history" @keydown.escape="escape">
    <HistoryPanel
      v-if="mine !== undefined"
      :mine="mine"
      :history="history"
      :path-refusal="pathRefusal"
      :failed="{}"
      @close="emit('close')"
      @open-path="openPath"
      @open-link="openLink"
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
