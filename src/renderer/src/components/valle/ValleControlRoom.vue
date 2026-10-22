<script setup lang="ts">
/*
 * The Control room's main zone (`DS/docs/screens/valle.md` VA1, VA3, Layout; 07 machine 28 `control`, machines 31, 32;
 * ISSUE-300, ISSUE-301, ISSUE-304): the mosaic of mine columns in the person's order, four across and scrolling sideways
 * past four, and the dashed "Add a mine here" slot after the last one.
 *
 * - Each column is its mine's zone: the plate behind it, its header (the name, what the zone shows when it is not its
 *   mine, `⤢` to dive in, and "⋯" for the zone menu), and what it shows. `⤢` dives into the mine (S28.03), disabled for
 *   a mine that cannot be entered (S28.04); a double-click on the art dives too, never one on a dwarf's sprite, which
 *   only pins or focuses its chat (S28.05). The art itself (the interior, its crew, the roster) is later issues' (`art`
 *   slot), and so is what a zone shows instead of its mine (`content` slot).
 * - The zone menu (machine 31) opens below its "⋯": swapping what the zone shows keeps the column in its slot.
 * - Each zone registers with the on-screen report (`VALLE_TRACK_ZONE`, S39.05): only a zone showing its mine counts.
 * - The scroller is the one whose sideways scroll a dive saves and a climb restores (S28.03, S28.12): `mosaic` exposes
 *   it.
 */
import type { MineId, ZoneContent } from '@dwarfai/contracts'
import { inject, onMounted, onUnmounted, onUpdated, shallowRef } from 'vue'
import type { SlotEntry } from '../../lib/valle/mosaic'
import type { ZoneMenuEntry, ZoneMenuItemId } from '../../lib/valle/zone'
import AddMineSlot from './AddMineSlot.vue'
import ZoneHeader from './ZoneHeader.vue'
import ZoneMenu from './ZoneMenu.vue'
import { VALLE_TRACK_ZONE } from './valleZones'

const props = defineProps<{
  /**
   * The mosaic's columns in order, each with its mine's name, whether it can be entered and what its zone shows (its
   * mine when not said).
   */
  columns: readonly { mineId: MineId; name: string; enterable: boolean; content?: ZoneContent }[]
  /** The zone menu open on a column, with its entries, or `null`. */
  menu?: { mineId: MineId; entries: readonly ZoneMenuEntry[] } | null
  /** The add slot's menu, open, or `null`. */
  slotEntries?: readonly SlotEntry[] | null
  /** Why the last "A new project…" added nothing, or `null`. */
  notice?: string | null
}>()
const emit = defineEmits<{
  dive: [mineId: MineId]
  'sprite-double-click': []
  menu: [mineId: MineId]
  'menu-pick': [id: ZoneMenuItemId]
  'menu-dismiss': []
  'slot-open': []
  'slot-dismiss': []
  'slot-pick': [mineId: MineId]
  'slot-new': []
}>()

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

// S39.05: each zone drawn registers once, and leaves the report with its column.
const track = inject(VALLE_TRACK_ZONE, null)
const tracked = new Map<Element, () => void>()
function syncTracked(): void {
  if (track === null || mosaic.value === null) return
  const drawn = new Set(mosaic.value.querySelectorAll('[data-valle-column]'))
  for (const [element, untrack] of tracked) {
    if (drawn.has(element)) continue
    untrack()
    tracked.delete(element)
  }
  for (const element of drawn) {
    if (tracked.has(element)) continue
    const mineId = element.getAttribute('data-valle-column') as MineId
    const content = (): ZoneContent =>
      props.columns.find((column) => column.mineId === mineId)?.content ?? 'mine'
    tracked.set(
      element,
      track(element, () => ({ mineId, content: content() }))
    )
  }
}
onMounted(syncTracked)
onUpdated(syncTracked)
onUnmounted(() => {
  for (const untrack of tracked.values()) untrack()
  tracked.clear()
})
</script>

<template>
  <div class="dm-valle__main" data-page="mines">
    <div ref="mosaic" class="dm-vmines" role="region" aria-label="Mines" data-valle-mosaic>
      <section
        v-for="column in columns"
        :key="column.mineId"
        class="dm-vz"
        :data-valle-column="column.mineId"
        data-valle-zone
        :data-content="column.content ?? 'mine'"
        :aria-label="`Mine ${column.name}`"
      >
        <div class="dm-vz__bg" aria-hidden="true"></div>
        <div class="dm-vz__head">
          <ZoneHeader
            :name="column.name"
            :content="column.content ?? 'mine'"
            :menu-open="menu?.mineId === column.mineId"
            @menu="emit('menu', column.mineId)"
          >
            <template #tools>
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
            </template>
          </ZoneHeader>
          <ZoneMenu
            v-if="menu?.mineId === column.mineId"
            :entries="menu.entries"
            @pick="(id) => emit('menu-pick', id)"
            @dismiss="emit('menu-dismiss')"
          />
        </div>
        <div
          v-if="(column.content ?? 'mine') === 'mine'"
          class="dm-vz__well"
          @dblclick="artDoubleClick($event, column)"
        >
          <slot name="art" :mine-id="column.mineId" />
        </div>
        <div v-else class="dm-vz__well" :data-zone-content="column.content">
          <slot name="content" :mine-id="column.mineId" :content="column.content" />
        </div>
      </section>
      <AddMineSlot
        :entries="slotEntries ?? null"
        :notice="notice ?? null"
        @open="emit('slot-open')"
        @dismiss="emit('slot-dismiss')"
        @pick="(mineId) => emit('slot-pick', mineId)"
        @new-project="emit('slot-new')"
      />
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
  /* Sideways only: a part growing or shrinking by FLIP never shows a vertical scrollbar, which would narrow the mosaic
     and clamp the scroll a climb restores. */
  overflow-y: hidden;
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
.dm-vz__head {
  position: relative;
  min-width: 0;
}
.dm-vz__well {
  position: relative;
  min-height: 0;
}
</style>
