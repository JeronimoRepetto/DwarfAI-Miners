<script setup lang="ts">
/*
 * The Work front's main zone (`DS/docs/screens/valle.md` VA2, Layout; 07 S28.16, S28.17; US-VALLE-001.AC04, .AC06,
 * .AC07; ISSUE-300, ISSUE-301): the compact mines list, 232 px, folded by "⇤ Fold the list" to a 44 px strip reading
 * "MINES" whose "Show the mines list" unfolds it, beside the one mine. The flag is the Work front layout's alone; the
 * freed width goes to the chat zone through the splitter's width formula (S33.08, ISSUE-305).
 *
 * - The list's rows, one per mine, the one shown marked current: picking another swaps it in place (S28.15, 180 ms).
 * - The one mine as its zone: the plate, the header with its name, the art, the parts the dive's FLIP moves into place
 *   (`flip.ts`). Its tools (ambience, history) and the art itself are later issues' (`art` slot).
 */
import type { MineId } from '@dwarfai/contracts'
import { computed } from 'vue'
import { VALLE_LIST_FOLDED_WIDTH, VALLE_LIST_WIDTH } from '../../lib/valle/preset'

const props = defineProps<{
  foldedList: boolean
  /** The compact list's mines, in order. */
  mines: readonly { mineId: MineId; name: string }[]
  /** The Work front's one mine, if known. */
  mine: { mineId: MineId; name: string } | null
}>()
const emit = defineEmits<{ fold: []; unfold: []; pick: [mineId: MineId] }>()

const listWidth = computed(
  () => `${props.foldedList ? VALLE_LIST_FOLDED_WIDTH : VALLE_LIST_WIDTH}px`
)
</script>

<template>
  <div class="dm-valle__main" data-page="mines" :style="{ '--list-w': listWidth }">
    <section class="dm-mrows" aria-label="Mines list" :data-folded="foldedList ? 'true' : 'false'">
      <button
        v-if="foldedList"
        type="button"
        class="dm-mrows__strip"
        aria-label="Show the mines list"
        title="Show the mines list"
        @click="emit('unfold')"
      >
        MINES
      </button>
      <header v-else class="dm-mrows__head">
        <span class="dm-mrows__title">Mines</span>
        <button
          type="button"
          class="dm-mrows__fold"
          aria-label="Fold the list"
          title="Fold the list"
          @click="emit('fold')"
        >
          ⇤
        </button>
      </header>
      <div v-if="!foldedList" class="dm-mrows__list">
        <button
          v-for="row in mines"
          :key="row.mineId"
          type="button"
          class="dm-mrow"
          :data-valle-row="row.mineId"
          :aria-current="row.mineId === mine?.mineId ? 'true' : undefined"
          @click="emit('pick', row.mineId)"
        >
          {{ row.name }}
        </button>
      </div>
    </section>
    <div class="dm-vmines" role="region" aria-label="Mines">
      <section
        v-if="mine !== null"
        class="dm-vz"
        :data-valle-front-mine="mine.mineId"
        :aria-label="`Mine ${mine.name}`"
      >
        <div class="dm-vz__bg" aria-hidden="true"></div>
        <header class="dm-vz__title">
          <span class="dm-vz__name">{{ mine.name }}</span>
          <span class="dm-vz__tools"></span>
        </header>
        <div class="dm-vz__well">
          <slot name="art" :mine-id="mine.mineId" />
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.dm-valle__main {
  display: grid;
  grid-template-columns: var(--list-w) minmax(0, 1fr);
  gap: 6px;
  min-width: 0;
  min-height: 0;
}
.dm-mrows {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.dm-mrows__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.dm-mrows__strip {
  width: 100%;
  height: 100%;
  writing-mode: vertical-rl;
}
.dm-mrows__list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-height: 0;
  overflow-y: auto;
}
.dm-mrow {
  overflow: hidden;
  text-align: start;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dm-vmines {
  display: grid;
  min-width: 0;
  min-height: 0;
}
.dm-vz {
  position: relative;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  min-width: 0;
  min-height: 0;
}
.dm-vz__bg {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.dm-vz__title {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  min-width: 0;
}
.dm-vz__well {
  position: relative;
  min-height: 0;
}
</style>
