<script setup lang="ts">
/*
 * The mine's history as a drawer under the Work front's chat tabs and panes (`DS/docs/components.md`
 * organisms/chat-deck, `.dm-cdeck__drawer`; 07 machine 36; US-VALLE-011; UC-061; ISSUE-308). It hosts the Panel's own
 * history panel through `ValleZoneHistory` (the same composable over a store of its own, its failed sends marked from
 * the chats Valle hosts): the same content as the Panel's, only somewhere else (AC04).
 *
 * Presentational: drawn by the deck in its `drawer` slot, under the panes, never over them. The rise and the sink are
 * the Valle root's (`useValleHistoryDrawer`), on this element alone, `transform` and `opacity` only; the history's own
 * close (and Esc inside it) asks for the sink (S36.03).
 */
import type { MineId } from '@dwarfai/contracts'
import type { HistoryDrawerState } from '../../lib/valle/historyDrawer'
import ValleZoneHistory from './ValleZoneHistory.vue'

defineProps<{
  mineId: MineId
  /** Machine 36's state, never `closed` while drawn. */
  state: HistoryDrawerState['kind']
}>()
const emit = defineEmits<{ close: [] }>()
</script>

<template>
  <div class="dm-cdeck__drawer" data-valle-drawer :data-drawer-state="state">
    <ValleZoneHistory :mine-id="mineId" @close="emit('close')" />
  </div>
</template>

<style scoped>
/* `DS/docs/components.md` organisms/chat-deck, Geometry: `.dm-cdeck__drawer`. */
.dm-cdeck__drawer {
  display: flex;
  min-height: 0;
}
.dm-cdeck__drawer > * {
  flex: 1;
  min-width: 0;
}
</style>
