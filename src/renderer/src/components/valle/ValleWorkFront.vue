<script setup lang="ts">
/*
 * The Work front's main zone (`DS/docs/screens/valle.md` VA2, Layout; 07 S28.16, S28.17; US-VALLE-001.AC04, .AC06,
 * .AC07; ISSUE-300, ISSUE-301): the compact mines list, 232 px, folded by "⇤ Fold the list" to a 44 px strip reading
 * "MINES" whose "Show the mines list" unfolds it, beside the one mine. The flag is the Work front layout's alone; the
 * freed width goes to the chat zone through the splitter's width formula (S33.08, ISSUE-305).
 *
 * - The list's rows, one per mine, the one shown marked current: picking another swaps it in place (S28.15, 180 ms).
 * - The one mine as its zone: the plate, the header with its name, what the zone shows when it is not its mine and the
 *   "⋯" of its zone menu (07 machine 31; ISSUE-304: no mines list and no "Close this column" here), the art, the parts
 *   the dive's FLIP moves into place (`flip.ts`). The art (`art` slot) and the roster (`roster` slot) are the host's,
 *   drawn with the Panel's own parts; "+ Dwarf" under the roster reports the mine (`add`, S29.16). What the zone shows
 *   instead of its mine is the `content` slot.
 * - "Mine history · opens under the chats" in the mine's toolbar asks for the history drawer under the chats (07 S36.01;
 *   US-VALLE-011; ISSUE-308), reporting whether it is open (`aria-expanded`); the drawer itself is the deck's.
 * - The zone registers with the on-screen report (`VALLE_TRACK_ZONE`, S39.05): it counts only while showing its mine.
 * - The current mine (07 machine 35; US-VALLE-013.AC05, .AC11; ISSUE-307): the one mine shown is always current, its
 *   zone with `aria-current`, ", current" in its name and the corner brackets in its body; its list line wears the gold
 *   face with the list's own small brackets and no brass ring (brass is needs you). A single click on its painting or
 *   header reports it (S35.02).
 */
import type { MineId, ZoneContent } from '@dwarfai/contracts'
import { computed, inject, onUnmounted, shallowRef, watch } from 'vue'
import { VALLE_LIST_FOLDED_WIDTH, VALLE_LIST_WIDTH } from '../../lib/valle/preset'
import type { ZoneMenuEntry, ZoneMenuItemId } from '../../lib/valle/zone'
import { ADD_DWARF_LABEL } from '../../lib/scene/mineColumn'
import ActionButton from '../controls/ActionButton.vue'
import CurrentMineMark from './CurrentMineMark.vue'
import ZoneHeader from './ZoneHeader.vue'
import ZoneMenu from './ZoneMenu.vue'
import { VALLE_TRACK_ZONE } from './valleZones'

const props = defineProps<{
  foldedList: boolean
  /** The compact list's mines, in order. */
  mines: readonly { mineId: MineId; name: string }[]
  /** The Work front's one mine, if known. */
  mine: { mineId: MineId; name: string } | null
  /** That mine cannot be entered (`DS` organisms/mine-zone `data-closed`): "+ Dwarf" is disabled. */
  closed?: boolean
  /** What the one zone shows. */
  content?: ZoneContent
  /** Its zone menu's entries while open, or `null`. */
  menu?: readonly ZoneMenuEntry[] | null
  /** A dive or a climb plays (machine 28): the current mark hides until it settles. */
  moving?: boolean
  /** The history drawer under the chats is drawn (07 machine 36). */
  historyOpen?: boolean
}>()
const emit = defineEmits<{
  fold: []
  unfold: []
  pick: [mineId: MineId]
  menu: []
  'menu-pick': [id: ZoneMenuItemId]
  'menu-dismiss': []
  /** S35.02: a single click on the mine's painting or header. */
  current: [mineId: MineId]
  /** S36.01: "Mine history" in the mine's toolbar. */
  history: [mineId: MineId]
  /** S29.16: "+ Dwarf" under the roster, a new dwarf in this mine. */
  add: [mineId: MineId]
}>()

/** A dwarf's sprite, or a control in the header or the art: its press is its own, never a click on the painting. */
const NOT_PAINTING =
  '[data-valle-sprite], .dm-vdwarf, .dm-dwarf, button, a, input, [role="menu"], [role="menuitem"]'

function zoneClick(event: MouseEvent): void {
  const mineId = props.mine?.mineId
  if (mineId === undefined) return
  const target = event.target
  if (target instanceof Element && target.closest(NOT_PAINTING) !== null) return
  emit('current', mineId)
}

const shows = computed((): ZoneContent => props.content ?? 'mine')

// S39.05: the one zone registers while drawn, for the mine it holds.
const track = inject(VALLE_TRACK_ZONE, null)
const zone = shallowRef<HTMLElement | null>(null)
let untrack: (() => void) | null = null
watch(
  [zone, () => props.mine?.mineId],
  ([element]) => {
    untrack?.()
    untrack = null
    if (element === null || track === null) return
    const mineId = props.mine?.mineId
    if (mineId === undefined) return
    // Another mine swapped in (S28.15) registers the zone anew, for that mine.
    untrack = track(element, () => ({ mineId, content: shows.value }))
  },
  { flush: 'post' }
)
onUnmounted(() => untrack?.())

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
          :data-current="row.mineId === mine?.mineId ? 'true' : 'false'"
          :aria-current="row.mineId === mine?.mineId ? 'true' : undefined"
          @click="emit('pick', row.mineId)"
        >
          {{ row.name }}<CurrentMineMark :current="row.mineId === mine?.mineId" size="list" />
        </button>
      </div>
    </section>
    <div class="dm-vmines" role="region" aria-label="Mines">
      <section
        v-if="mine !== null"
        ref="zone"
        class="dm-vz"
        :data-valle-front-mine="mine.mineId"
        data-valle-zone
        :data-content="shows"
        data-current="true"
        aria-current="true"
        :aria-label="`Mine ${mine.name}, current`"
      >
        <div class="dm-vz__bg" aria-hidden="true"></div>
        <div class="dm-vz__head" @click="zoneClick">
          <ZoneHeader
            :name="mine.name"
            :content="shows"
            :menu-open="(menu ?? null) !== null"
            @menu="emit('menu')"
          >
            <template #tools>
              <ActionButton
                icon="history"
                size="sm"
                title="Mine history · opens under the chats"
                :aria-expanded="historyOpen === true ? 'true' : 'false'"
                data-valle-history
                @click="emit('history', mine.mineId)"
              />
            </template>
          </ZoneHeader>
          <ZoneMenu
            v-if="menu"
            :entries="menu"
            @pick="(id) => emit('menu-pick', id)"
            @dismiss="emit('menu-dismiss')"
          />
        </div>
        <div v-if="shows === 'mine'" class="dm-vz__well" @click="zoneClick">
          <slot name="art" :mine-id="mine.mineId" />
          <CurrentMineMark :current="true" size="zone" :moving="moving === true" />
        </div>
        <div v-else class="dm-vz__well" :data-zone-content="shows">
          <slot name="content" :mine-id="mine.mineId" :content="shows" />
          <CurrentMineMark :current="true" size="zone" :moving="moving === true" />
        </div>
        <div v-if="shows === 'mine'" class="dm-vz__foot">
          <div class="dm-vz__roster"><slot name="roster" :mine-id="mine.mineId" /></div>
          <ActionButton
            :label="ADD_DWARF_LABEL"
            variant="primary"
            :title="`New dwarf in ${mine.name}`"
            :disabled="closed"
            @click="emit('add', mine.mineId)"
          />
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
  position: relative;
  overflow: hidden;
  text-align: start;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* The line of the mine shown, the current mine: the gold face (`DS` organisms/mine-rows), no brass ring. */
.dm-mrow[data-current='true'] {
  background: var(--gold-select);
  box-shadow:
    inset 2px 2px 0 0 var(--gold),
    inset -2px -2px 0 0 var(--gold-deep),
    0 0 0 2px var(--rock-lo);
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
.dm-vz__head {
  position: relative;
  min-width: 0;
}
.dm-vz__well {
  position: relative;
  min-height: 0;
}
</style>
