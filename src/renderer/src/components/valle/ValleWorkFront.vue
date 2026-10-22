<script setup lang="ts">
/*
 * The Work front's main zone (`DS/docs/screens/valle.md` VA2, Layout; 07 S28.16, S28.17; US-VALLE-001.AC04, .AC06,
 * .AC07; ISSUE-300): the compact mines list, 232 px, folded by "⇤ Fold the list" to a 44 px strip reading "MINES"
 * whose "Show the mines list" unfolds it, beside the one mine. The flag is the Work front layout's alone. The list's
 * rows and the mine's zone are their issues' (slot); the freed width goes to the chat zone through the splitter's width
 * formula (S33.08, ISSUE-305).
 */
import { computed } from 'vue'
import { VALLE_LIST_FOLDED_WIDTH, VALLE_LIST_WIDTH } from '../../lib/valle/preset'

const props = defineProps<{ foldedList: boolean }>()
const emit = defineEmits<{ fold: []; unfold: [] }>()

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
    </section>
    <div class="dm-vmines" role="region" aria-label="Mines">
      <slot />
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
.dm-vmines {
  min-width: 0;
  min-height: 0;
}
</style>
