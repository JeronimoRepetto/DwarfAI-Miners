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
 * - With no column the mosaic is empty (07 machine 38, S38.05; ISSUE-310): only the add slot shows, and no text, since the
 *   package has no copy for it (§24 I-34). A pure read of the order, nothing stored.
 * - The current mine (07 machine 35; ISSUE-307): the host names it; its zone carries `aria-current` and ", current" in
 *   its name, and its body the corner brackets (`CurrentMineMark`), inside the needs-you ring the zone hosts
 *   (`data-needs`). A single click on a zone's painting or header, no dwarf and no
 *   control touched, reports the mine (S35.02); a double-click on the art still dives.
 * - The needs-you ring (07 machine 34; `DS` organisms/mine-zone `.dm-vz__ring`; ISSUE-306): the heavy brass outline a zone
 *   wears while a dwarf of its mine waits on the person, drawn above the plates and never over the art's middle, the
 *   brackets nested inside it and never merged with them. A needs-you jump to the mine calls it (S34.05): the ring
 *   flashes once, restarted by each call (`called`, the jump's number).
 */
import type { MineId, ZoneContent } from '@dwarfai/contracts'
import { computed, inject, onMounted, onUnmounted, onUpdated, shallowRef } from 'vue'
import { mosaicState } from '../../lib/valle/emptyStates'
import type { SlotEntry } from '../../lib/valle/mosaic'
import type { ZoneMenuEntry, ZoneMenuItemId } from '../../lib/valle/zone'
import AddMineSlot from './AddMineSlot.vue'
import CurrentMineMark from './CurrentMineMark.vue'
import ZoneHeader from './ZoneHeader.vue'
import ZoneMenu from './ZoneMenu.vue'
import { VALLE_TRACK_ZONE } from './valleZones'

const props = defineProps<{
  /**
   * The mosaic's columns in order, each with its mine's name, whether it can be entered and what its zone shows (its
   * mine when not said).
   */
  columns: readonly {
    mineId: MineId
    name: string
    enterable: boolean
    content?: ZoneContent
    /** The current mine (07 machine 35): at most one column. */
    current?: boolean
    /** A dwarf of this mine waits on the person: the zone hosts the needs-you ring. */
    needs?: boolean
    /** The number of the needs-you jump that called this zone (S34.05), 0 when none: each call flashes the ring. */
    called?: number
  }[]
  /** The zone menu open on a column, with its entries, or `null`. */
  menu?: { mineId: MineId; entries: readonly ZoneMenuEntry[] } | null
  /** The add slot's menu, open, or `null`. */
  slotEntries?: readonly SlotEntry[] | null
  /** Why the last "A new project…" added nothing, or `null`. */
  notice?: string | null
  /** A dive or a climb plays (machine 28): the current mark hides until it settles. */
  moving?: boolean
  /** Reduced motion is on (NFR-A11Y-10; US-SHELL-011.AC05): a called zone's ring is not drawn, its outline stays. */
  still?: boolean
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
  /** S35.02: a single click on the mine's painting or header. */
  current: [mineId: MineId]
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

/** A control in the header or the art (⤢, "⋯", a menu): its press is its own, never a click on the painting. */
const CONTROL = 'button, a, input, [role="menu"], [role="menuitem"]'

function zoneClick(event: MouseEvent, mineId: MineId): void {
  const target = event.target
  if (target instanceof Element && target.closest(`${SPRITE}, ${CONTROL}`) !== null) return
  emit('current', mineId)
}

/** Machine 38 `mosaic-empty`: with no column only the add slot shows, and no text of its own (07 §24 I-34). */
const empty = computed(
  () => mosaicState(props.columns.map((column) => column.mineId)) === 'mosaic-empty'
)

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
    <div
      ref="mosaic"
      class="dm-vmines"
      role="region"
      aria-label="Mines"
      data-valle-mosaic
      :data-empty="empty ? 'true' : 'false'"
    >
      <section
        v-for="column in columns"
        :key="column.mineId"
        class="dm-vz"
        :data-valle-column="column.mineId"
        data-valle-zone
        :data-content="column.content ?? 'mine'"
        :data-current="column.current ? 'true' : 'false'"
        :data-needs="column.needs ? 'true' : 'false'"
        :aria-current="column.current ? 'true' : undefined"
        :aria-label="`Mine ${column.name}${column.current ? ', current' : ''}`"
      >
        <div class="dm-vz__bg" aria-hidden="true"></div>
        <span
          :key="`ring-${column.called ?? 0}`"
          class="dm-vz__ring"
          :class="{ 'is-called': !still && (column.called ?? 0) > 0 }"
          aria-hidden="true"
        ></span>
        <div class="dm-vz__head" @click="zoneClick($event, column.mineId)">
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
          @click="zoneClick($event, column.mineId)"
          @dblclick="artDoubleClick($event, column)"
        >
          <slot name="art" :mine-id="column.mineId" />
          <CurrentMineMark
            :current="column.current === true"
            size="zone"
            :moving="moving === true"
          />
        </div>
        <div v-else class="dm-vz__well" :data-zone-content="column.content">
          <slot name="content" :mine-id="column.mineId" :content="column.content" />
          <CurrentMineMark
            :current="column.current === true"
            size="zone"
            :moving="moving === true"
          />
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
/*
 * Attention level 1 (`DS` organisms/mine-zone): the heavy outline Veta uses, above the plates, never over the art's middle.
 * A call flashes it once; under reduced motion the call ring is not drawn at all (ISSUE-311: the host's `still`, and this
 * media rule).
 */
.dm-vz__ring {
  position: absolute;
  inset: 0;
  z-index: 3;
  opacity: 0;
  pointer-events: none;
  box-shadow:
    inset 0 0 0 4px var(--brass),
    inset 0 0 0 6px var(--rock-lo);
}
.dm-vz[data-needs='true'] > .dm-vz__ring {
  opacity: 1;
}
.dm-vz__ring::after {
  content: '';
  position: absolute;
  inset: 0;
  opacity: 0;
  box-shadow: inset 0 0 0 8px var(--parch-hi);
}
.dm-vz__ring.is-called::after {
  animation: dm-vz-call 1200ms steps(1, end) both;
}
@keyframes dm-vz-call {
  0% {
    opacity: 1;
  }
  25% {
    opacity: 0;
  }
  50% {
    opacity: 1;
  }
  75%,
  100% {
    opacity: 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .dm-vz__ring.is-called::after {
    animation: none;
    opacity: 0;
  }
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
