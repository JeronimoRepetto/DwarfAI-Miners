<script setup lang="ts">
/*
 * The Work front's main zone (`DS/docs/screens/valle.md` VA2, Layout; 07 S28.16, S28.17; US-VALLE-001.AC04, .AC06,
 * .AC07; ISSUE-300, ISSUE-301): the compact mines list, 232 px, folded by "⇤ Fold the list" to a 44 px strip reading
 * "MINES" whose "Show the mines list" unfolds it, beside the one mine. The flag is the Work front layout's alone; the
 * freed width goes to the chat zone through the splitter's width formula (S33.08, ISSUE-305).
 *
 * - The list's rows, one per mine, the one shown marked current: picking another swaps it in place (S28.15, 180 ms). Its
 *   header holds the sort, "Add a mine" and the fold, a search field lies under it, and a line with dwarfs waiting
 *   carries the brass "?" (`DS` organisms/mine-rows; EPIC-20 visual parity): the lines are hidden and reordered, never
 *   rebuilt; the order's toast and the add are the host's (`sorted`, `add-mine`).
 * - The one mine as its zone: the plate, the header with its name, what the zone shows when it is not its mine and the
 *   "⋯" of its zone menu (07 machine 31; ISSUE-304: no mines list and no "Close this column" here), the art, the parts
 *   the dive's FLIP moves into place (`flip.ts`). The art (`art` slot) and the roster (`roster` slot) are the host's,
 *   drawn with the Panel's own parts; "+ Dwarf" under the roster reports the mine (`add`, S29.16). What the zone shows
 *   instead of its mine is the `content` slot.
 * - ♪ in the mine's toolbar, before History (`DS` organisms/mine-zone `.dm-vz__front-only`; EPIC-20 visual parity): the
 *   mine's ambience muted or on again, the same mute its zone menu toggles (S31.08), reported (`ambience`).
 * - "Mine history · opens under the chats" in the mine's toolbar asks for the history drawer under the chats (07 S36.01;
 *   US-VALLE-011; ISSUE-308), reporting whether it is open (`aria-expanded`); the drawer itself is the deck's.
 * - The zone registers with the on-screen report (`VALLE_TRACK_ZONE`, S39.05): it counts only while showing its mine.
 * - The current mine (07 machine 35; US-VALLE-013.AC05, .AC11; ISSUE-307): the one mine shown is always current, its
 *   zone with `aria-current`, ", current" in its name and the corner brackets in its body; its list line wears the gold
 *   face with the list's own small brackets and no brass ring (brass is needs you). A single click on its painting or
 *   header reports it (S35.02).
 */
import type { MineId, ZoneContent } from '@dwarfai/contracts'
import { computed, inject, onUnmounted, ref, shallowRef, watch } from 'vue'
import { VALLE_LIST_FOLDED_WIDTH, VALLE_LIST_WIDTH } from '../../lib/valle/preset'
import type { ZoneMenuEntry, ZoneMenuItemId } from '../../lib/valle/zone'
import { ADD_DWARF_LABEL } from '../../lib/scene/mineColumn'
import { mineMinimum } from '../../lib/valle/split'
import {
  MINE_ROW_SORT_DEFAULT,
  MINE_ROWS_EMPTY,
  mineRowAsk,
  mineRowLabel,
  mineRowSortTitle,
  mineRowSortToast,
  nextMineRowSort,
  shownMineRows,
  type MineRowFacts
} from '../../lib/valle/mineRows'
import type { MineTier } from '../../types'
import TierChip from '../controls/TierChip.vue'
import PixelIcon from '../icon/PixelIcon.vue'
import ActionButton from '../controls/ActionButton.vue'
import InputField from '../controls/InputField.vue'
import CurrentMineMark from './CurrentMineMark.vue'
import ZoneHeader from './ZoneHeader.vue'
import ZoneMenu from './ZoneMenu.vue'
import { VALLE_TRACK_ZONE } from './valleZones'

const props = defineProps<{
  foldedList: boolean
  /**
   * The compact list's mines: each one's tier, its crew line, and the facts its order and "?" read (`count` dwarfs,
   * `needs` of them waiting, ever `measured`, `enterable`).
   */
  mines: readonly {
    mineId: MineId
    name: string
    tier?: MineTier | null
    crew?: string
    count?: number
    needs?: number
    measured?: boolean
    enterable?: boolean
  }[]
  /** The Work front's one mine, if known. */
  mine: { mineId: MineId; name: string; tier?: MineTier | null; portraits?: number } | null
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
  /** The mine's ambience is muted (`mutedMineIds`, S31.08): ♪ reads it. */
  muted?: boolean
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
  /** ♪ in the mine's toolbar: its ambience muted or on again (S31.08). */
  ambience: [mineId: MineId]
  /** "Add a mine" in the list's header. */
  'add-mine': []
  /** The order changed: its toast's words. */
  sorted: [text: string]
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

/** The list's search and order, the list's own view state (`DS` mine-rows.js `query`, `sortI`). */
const query = ref('')
const sort = ref(MINE_ROW_SORT_DEFAULT)
const facts = computed((): MineRowFacts[] =>
  props.mines.map((row) => ({
    mineId: row.mineId,
    name: row.name,
    tier: row.tier ?? null,
    measured: row.measured ?? (row.tier ?? null) !== null,
    crew: row.count ?? 0,
    enterable: row.enterable ?? true,
    needs: row.needs ?? 0
  }))
)
const rows = computed(() => {
  const byId = new Map(props.mines.map((row) => [row.mineId, row]))
  return shownMineRows(facts.value, query.value, sort.value).map((shown) => ({
    ...byId.get(shown.mineId)!,
    facts: shown
  }))
})
function cycleSort(): void {
  sort.value = nextMineRowSort(sort.value)
  emit('sorted', mineRowSortToast(sort.value))
}

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
        class="dm-mrows__strip dm-mrows__unfold m-mat"
        aria-label="Show the mines list"
        title="Show the mines list"
        @click="emit('unfold')"
      >
        <PixelIcon name="mines" :scale="2" />
        <span>MINES</span>
      </button>
      <div v-else class="dm-mrows__open">
        <header class="dm-mrows__head m-mat">
          <h2 class="dm-mrows__title">Mines</h2>
          <span class="dm-mrows__grow"></span>
          <ActionButton
            icon="sort"
            size="sm"
            :title="mineRowSortTitle(sort)"
            data-mrows-sort
            @click="cycleSort"
          />
          <ActionButton icon="add" size="sm" title="Add a mine" @click="emit('add-mine')" />
          <ActionButton
            class="dm-mrows__fold"
            icon="chevron"
            size="sm"
            title="Fold the list"
            @click="emit('fold')"
          />
        </header>
        <div class="dm-mrows__search">
          <InputField
            v-model:value="query"
            search
            placeholder="Search mines"
            label="Search mines"
          />
        </div>
        <div class="dm-mrows__list">
          <button
            v-for="row in rows"
            :key="row.mineId"
            type="button"
            class="dm-mrow"
            :data-valle-row="row.mineId"
            :data-current="row.mineId === mine?.mineId ? 'true' : 'false'"
            :aria-current="row.mineId === mine?.mineId ? 'true' : undefined"
            :aria-label="mineRowLabel(row.facts)"
            :data-needs="row.facts.needs > 0 ? 'true' : 'false'"
            @click="emit('pick', row.mineId)"
          >
            <TierChip v-if="row.tier" :tier="row.tier" />
            <span class="dm-mrow__name">{{ row.name }}</span>
            <span v-if="row.crew" class="dm-mrow__crew">{{ row.crew }}</span>
            <span class="dm-mrow__ask" aria-hidden="true">{{ mineRowAsk(row.facts.needs) }}</span>
            <CurrentMineMark :current="row.mineId === mine?.mineId" size="list" />
          </button>
        </div>
        <p v-if="rows.length === 0 && mines.length > 0" class="dm-mrows__empty">
          {{ MINE_ROWS_EMPTY }}
        </p>
      </div>
    </section>
    <div class="dm-vmines" role="region" aria-label="Mines">
      <section
        v-if="mine !== null"
        ref="zone"
        class="dm-vz is-front"
        :data-valle-front-mine="mine.mineId"
        data-valle-zone
        :data-content="shows"
        data-current="true"
        aria-current="true"
        :aria-label="`Mine ${mine.name}, current`"
        :data-closed="closed ? 'true' : 'false'"
        :data-ambience="muted ? 'off' : 'on'"
        :style="{ '--min-front': `${mineMinimum(mine.portraits ?? 0)}px` }"
      >
        <div class="dm-vz__bg" aria-hidden="true"></div>
        <div class="dm-vz__head" @click="zoneClick">
          <ZoneHeader
            :name="mine.name"
            :tier="mine.tier ?? null"
            :content="shows"
            :menu-open="(menu ?? null) !== null"
            @menu="emit('menu')"
          >
            <template #tools>
              <ActionButton
                :icon="muted ? 'ambience-off' : 'ambience-on'"
                size="sm"
                title="Mine ambience"
                :pressed="!muted"
                data-valle-ambience
                @click="emit('ambience', mine.mineId)"
              />
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
          <span class="dm-vz__footbg m-mat" aria-hidden="true"></span>
          <div class="dm-vz__roster"><slot name="roster" :mine-id="mine.mineId" /></div>
          <ActionButton
            class="dm-vz__adds"
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
/* `DS/docs/screens/valle.md` Parts: the Work front's main zone, the list beside the one mine. */
.dm-valle__main {
  position: relative;
  display: grid;
  grid-template-columns: var(--list-w) minmax(0, 1fr);
  gap: 6px;
  min-width: 0;
  min-height: 0;
}
/* `DS` organisms/mine-rows, mine-rows.css. */
.dm-mrows {
  position: relative;
  display: grid;
  min-width: 0;
  min-height: 0;
  height: 100%;
}
.dm-mrows__open {
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr) auto;
  gap: 4px;
  min-width: 0;
  min-height: 0;
}
.dm-mrows__head {
  --mat-fill: var(--wood);
  display: flex;
  align-items: center;
  gap: 0;
  height: 44px;
  padding: 0 2px 0 10px;
  margin: var(--px);
}
.dm-mrows__title {
  font: 400 var(--fs-title) / 1 var(--f-display);
  color: var(--gold);
}
.dm-mrows__grow {
  flex: 1;
}
.dm-mrows__fold :deep(svg) {
  transform: scaleX(-1);
}
.dm-mrows__search :deep(.dm-field) {
  margin: var(--px);
}
.dm-mrows__list {
  display: grid;
  align-content: start;
  gap: 2px;
  min-height: 0;
  overflow-y: auto;
  padding: 4px;
  background: var(--rock);
  box-shadow: inset 2px 2px 0 0 var(--rock-lo);
}
.dm-mrow {
  position: relative;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  grid-template-rows: auto auto;
  align-items: center;
  column-gap: 6px;
  min-height: 44px;
  padding: 4px 6px;
  text-align: start;
  background: var(--wood-lo);
  box-shadow:
    inset 2px 2px 0 0 var(--wood),
    inset -2px -2px 0 0 var(--rock-lo);
  transition: transform var(--dur-press) var(--ease-step);
}
.dm-mrow:hover {
  box-shadow:
    inset 2px 2px 0 0 var(--wood-hi),
    inset -2px -2px 0 0 var(--rock-lo),
    0 0 0 2px var(--brass-lo);
}
.dm-mrow:active {
  transform: translateY(var(--px));
}
/* The line of the mine shown, the current mine: the gold face (`DS` organisms/mine-rows), no brass ring. */
.dm-mrow[data-current='true'] {
  background: var(--gold-select);
  box-shadow:
    inset 2px 2px 0 0 var(--gold),
    inset -2px -2px 0 0 var(--gold-deep),
    0 0 0 2px var(--rock-lo);
}
.dm-mrow > :deep(.dm-tier) {
  grid-row: 1 / 3;
}
.dm-mrow__name {
  min-width: 0;
  overflow: hidden;
  font: 400 var(--fs-body) / 1.2 var(--f-meta);
  color: var(--parchment);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dm-mrow__crew {
  grid-column: 2;
  font: 400 var(--fs-meta) / 1.2 var(--f-meta);
  color: var(--ink-faint);
}
.dm-mrow[data-current='true'] .dm-mrow__crew {
  color: var(--parch-hi);
}
.dm-mrow__ask {
  grid-column: 3;
  grid-row: 1 / 3;
  font: 400 var(--fs-meta) / 1 var(--f-meta);
}
.dm-mrow[data-needs='true'] .dm-mrow__ask {
  display: grid;
  place-items: center;
  min-width: 18px;
  height: 18px;
  padding: 0 2px;
  color: var(--ink-on-light);
  background: var(--brass);
  box-shadow: 0 0 0 var(--px) var(--rock-lo);
}
.dm-mrows__empty {
  padding: 8px;
  font: 400 var(--fs-body) / 1.3 var(--f-meta);
  color: var(--ink-faint);
}
.dm-mrows__unfold {
  --mat-fill: var(--wood);
  display: grid;
  align-content: start;
  justify-items: center;
  gap: 8px;
  width: 100%;
  height: 100%;
  padding: 8px 0;
  font: 400 var(--fs-meta) / 1 var(--f-meta);
  color: var(--ink-soft);
  writing-mode: vertical-rl;
}
.dm-mrows__unfold > :deep(svg) {
  writing-mode: horizontal-tb;
}
.dm-mrows__unfold:hover {
  --mat-edge: var(--brass);
  color: var(--ink);
}
/* `DS` mine-zone.css, as the Work front's one mine (`.dm-vz.is-front`). */
.dm-vmines {
  display: flex;
  gap: 6px;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.dm-vz {
  position: relative;
  display: grid;
  flex: 1 1 auto;
  grid-template-rows: auto minmax(0, 1fr) auto;
  gap: 4px;
  min-width: var(--min-front, 300px);
  height: 100%;
  min-height: 0;
  padding: 4px;
}
.dm-vz__bg {
  position: absolute;
  inset: 0;
  transform-origin: 0 0;
  pointer-events: none;
  background: var(--rock-lo);
  box-shadow:
    inset 2px 2px 0 0 var(--wood-lo),
    inset -2px -2px 0 0 var(--rock-hi);
}
.dm-vz__head {
  position: relative;
  min-width: 0;
}
.dm-vz__well {
  position: relative;
  display: grid;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  container-type: size;
  place-items: center;
}
.dm-vz__well[data-zone-content] {
  container-type: normal;
  place-items: stretch;
}
.dm-vz__well[data-zone-content] > :deep(*) {
  min-width: 0;
  min-height: 0;
}
.dm-vz__foot {
  position: relative;
  display: flex;
  align-items: center;
  gap: 2px;
  height: 60px;
  padding: 0 4px 0 2px;
  min-width: 0;
}
.dm-vz__footbg {
  --mat-fill: var(--wood-lo);
  --mat-hi: var(--wood);
  --mat-lo: var(--rock-lo);
  position: absolute;
  inset: 0;
  transform-origin: 0 0;
  pointer-events: none;
}
.dm-vz__roster {
  position: relative;
  flex: 1;
  min-width: 0;
}
.dm-vz__adds {
  position: relative;
}
</style>
