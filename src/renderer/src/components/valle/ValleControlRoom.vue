<script setup lang="ts">
/*
 * The Control room's main zone (`DS/docs/screens/valle.md` VA1, Layout; 07 machine 28 `control`, S32.02; ISSUE-300,
 * ISSUE-301): the mosaic of mine columns in the restored order, four across and scrolling sideways past four.
 *
 * - Each column is its mine's zone: the plate behind it, its header (the name, then `⤢` to dive in), and its art, the
 *   parts the dive's FLIP moves (`flip.ts`). `⤢` dives into the mine (S28.03), disabled for a mine that cannot be
 *   entered (S28.04); a double-click on the art dives too, never one on a dwarf's sprite, which only pins or focuses its
 *   chat (S28.05). The art itself (the interior, its crew, the roster) is later issues' (`art` slot).
 * - The scroller is the one whose sideways scroll a dive saves and a climb restores (S28.03, S28.12): `mosaic` exposes
 *   it.
 */
import type { MineId } from '@dwarfai/contracts'
import { shallowRef } from 'vue'

defineProps<{
  /** The mosaic's columns in order, each with its mine's name and whether it can be entered. */
  columns: readonly { mineId: MineId; name: string; enterable: boolean }[]
}>()
const emit = defineEmits<{ dive: [mineId: MineId]; 'sprite-double-click': [] }>()

/** A dwarf's sprite inside the art: a double-click there never dives. */
const SPRITE = '[data-valle-sprite], .dm-vdwarf, .dm-dwarf'

function artDoubleClick(event: MouseEvent, column: { mineId: MineId; enterable: boolean }): void {
  const target = event.target
  if (target instanceof Element && target.closest(SPRITE) !== null) {
    emit('sprite-double-click')
    return
  }
  emit('dive', column.mineId)
}

const mosaic = shallowRef<HTMLElement | null>(null)
defineExpose({ mosaic })
</script>

<template>
  <div class="dm-valle__main" data-page="mines">
    <div ref="mosaic" class="dm-vmines" role="region" aria-label="Mines" data-valle-mosaic>
      <section
        v-for="column in columns"
        :key="column.mineId"
        class="dm-vz"
        :data-valle-column="column.mineId"
        :aria-label="`Mine ${column.name}`"
      >
        <div class="dm-vz__bg" aria-hidden="true"></div>
        <header class="dm-vz__title">
          <span class="dm-vz__name">{{ column.name }}</span>
          <span class="dm-vz__tools">
            <button
              type="button"
              class="dm-vz__dive"
              aria-label="Dive in · Work front on this mine"
              title="Dive in · Work front on this mine"
              :disabled="!column.enterable"
              @click="emit('dive', column.mineId)"
            >
              ⤢
            </button>
          </span>
        </header>
        <div class="dm-vz__well" @dblclick="artDoubleClick($event, column)">
          <slot name="art" :mine-id="column.mineId" />
        </div>
      </section>
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
  position: relative;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  flex: 0 0 max(232px, var(--col-w));
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
.dm-vz__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dm-vz__well {
  position: relative;
  min-height: 0;
}
</style>
