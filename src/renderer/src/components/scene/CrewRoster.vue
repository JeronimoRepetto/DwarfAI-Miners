<script setup lang="ts">
/*
 * The crew roster (#635), `molecules/crew-roster` in the design: the crew of one mine as portraits
 * under its interior, a group named "Crew". A portrait press does exactly what clicking the sprite
 * does (the column selects the dwarf and opens its chat); hover or focus shows its tooltip card.
 * Five fit; with six or more, the first four and a +N button whose menu lists the rest, opening
 * above it aligned to its start (screens/mine.md, As built). The row never scrolls, and a status
 * change patches a portrait in place: each is keyed by its dwarf. Who is shown and what the menu
 * says is lib/scene/crewRoster's.
 */
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import DwarfPortrait from '../dwarf/DwarfPortrait.vue'
import DwarfTip from '../dwarf/DwarfTip.vue'
import MenuList from '../overlay/MenuList.vue'
import TooltipCard from '../overlay/TooltipCard.vue'
import { useHoverTip } from '../../composables/useHoverTip'
import {
  ROSTER_EMPTY,
  ROSTER_MAX,
  rosterMenuItems,
  rosterMoreLabel,
  rosterSplit
} from '../../lib/scene/crewRoster'
import { placeFloating } from '../../lib/overlay/menu'
import { sceneDwarfStatus } from '../../lib/scene/sceneDwarf'
import { dwarfDisplayName } from '../../lib/dwarf/displayName'
import type { Dwarf } from '../../types'

const props = withDefaults(
  defineProps<{ dwarfs: Dwarf[]; selectedId?: string | null; max?: number }>(),
  { selectedId: null, max: ROSTER_MAX }
)
const emit = defineEmits<{ pick: [dwarf: Dwarf] }>()

const split = computed(() => rosterSplit(props.dwarfs, props.max))
const menuItems = computed(() => rosterMenuItems(split.value.rest))

const tip = useHoverTip<string>()
const tipDwarf = computed(() => props.dwarfs.find((dwarf) => dwarf.id === tip.shown.value))

function pick(dwarf: Dwarf): void {
  tip.hide()
  emit('pick', dwarf)
}

/*
 * The +N menu: the menu molecule's own behaviour (MenuButton's), on a trigger of the roster's own
 * shape. The first item takes focus once it shows; Esc or picking closes it and hands the focus
 * back to +N; a press outside closes it and takes nothing back; pressing +N again closes it.
 */
const open = ref(false)
const more = ref<HTMLButtonElement | null>(null)
const menu = ref<HTMLElement | null>(null)
const list = ref<InstanceType<typeof MenuList> | null>(null)
const place = ref<{ left: number; top: number } | null>(null)

function outside(event: PointerEvent): void {
  const target = event.target as Node | null
  if (target && (menu.value?.contains(target) || more.value?.contains(target))) return
  close(false)
}

async function show(): Promise<void> {
  open.value = true
  place.value = null
  await nextTick()
  const anchor = more.value?.getBoundingClientRect() ?? { left: 0, top: 0, right: 0, bottom: 0 }
  const box = menu.value?.getBoundingClientRect() ?? { width: 0, height: 0 }
  place.value = placeFloating(
    anchor,
    box,
    { width: window.innerWidth, height: window.innerHeight },
    { side: 'top', align: 'start' }
  )
  document.addEventListener('pointerdown', outside, true)
  // Only now is the menu visible: a hidden element takes no focus in a real browser.
  await nextTick()
  list.value?.focusFirst()
}

function close(refocus: boolean): void {
  if (!open.value) return
  open.value = false
  document.removeEventListener('pointerdown', outside, true)
  if (refocus) more.value?.focus()
}

function toggle(): void {
  if (open.value) close(true)
  else void show()
}

function pickRest(index: number): void {
  close(true)
  const dwarf = split.value.rest[index]
  if (dwarf) emit('pick', dwarf)
}

onBeforeUnmount(() => document.removeEventListener('pointerdown', outside, true))
</script>

<template>
  <div class="dm-roster" role="group" aria-label="Crew">
    <DwarfPortrait
      v-for="dwarf in split.shown"
      :key="dwarf.id"
      :role="dwarf.role"
      :status="sceneDwarfStatus(dwarf)"
      :name="dwarfDisplayName(dwarf)"
      :selected="dwarf.id === selectedId"
      interactive
      :data-dwarf="dwarf.id"
      @click="pick(dwarf)"
      @pointerenter="tip.hover(dwarf.id, $event)"
      @pointerleave="tip.leave"
      @pointerdown="tip.press"
      @mousedown.prevent
      @focus="tip.focus(dwarf.id, $event)"
      @blur="tip.hide"
    />
    <button
      v-if="split.rest.length > 0"
      ref="more"
      class="dm-roster__more m-mat"
      type="button"
      :aria-label="rosterMoreLabel(split.rest.length)"
      aria-haspopup="menu"
      :aria-expanded="open ? 'true' : 'false'"
      @click="toggle"
    >
      +{{ split.rest.length }}
    </button>
    <span v-if="dwarfs.length === 0" class="dm-roster__empty">{{ ROSTER_EMPTY }}</span>
  </div>
  <Teleport to="body">
    <Transition name="dm-menu-pop">
      <div
        v-if="open"
        ref="menu"
        class="dm-roster-float"
        :style="
          place
            ? { left: place.left + 'px', top: place.top + 'px' }
            : { left: '0px', top: '0px', visibility: 'hidden' }
        "
      >
        <MenuList ref="list" :items="menuItems" @pick="pickRest" @close="close(true)" />
      </div>
    </Transition>
    <Transition name="dm-tip-pop">
      <TooltipCard v-if="tipDwarf" :ref="tip.card" :style="tip.style.value">
        <DwarfTip :dwarf="tipDwarf" />
      </TooltipCard>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* The design's crew-roster.css, rule for rule. */
.dm-roster {
  display: flex;
  min-height: 52px;
  gap: 4px;
  padding: 4px 6px;
  align-items: center;
  overflow: hidden;
}
.dm-roster__more {
  --mat-fill: var(--wood-lo);
  --mat-hi: var(--wood);
  --mat-lo: var(--rock-lo);
  --mat-edge: var(--rock-lo);
  display: grid;
  width: 40px;
  height: 44px;
  margin: var(--px);
  font: var(--fs-meta) / 1 var(--f-meta);
  color: var(--ink-soft);
  place-items: center;
}
.dm-roster__more:hover {
  --mat-edge: var(--brass);
  color: var(--ink);
}
.dm-roster__empty {
  padding: 0 4px;
  font: var(--fs-meta) / 1.3 var(--f-meta);
  color: var(--ink-faint);
}
.dm-roster-float {
  position: fixed;
  z-index: var(--z-menu);
}
/* The menu's and the tooltip's entries and exits (motion.md, Overlays): transform and opacity. */
.dm-menu-pop-enter-active {
  transition:
    transform var(--dur-base) var(--ease-out),
    opacity var(--dur-base) var(--ease-out);
}
.dm-menu-pop-leave-active {
  transition:
    transform var(--dur-fast) var(--ease-in),
    opacity var(--dur-fast) var(--ease-in);
}
.dm-menu-pop-enter-from {
  opacity: 0;
  transform: translateY(calc(var(--rise) * -1));
}
.dm-menu-pop-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
.dm-tip-pop-enter-active {
  transition:
    transform var(--dur-base) var(--ease-out),
    opacity var(--dur-base) var(--ease-out);
}
.dm-tip-pop-leave-active {
  transition: opacity var(--dur-fast) var(--ease-in);
}
.dm-tip-pop-enter-from {
  opacity: 0;
  transform: translateY(var(--tip-rise));
}
.dm-tip-pop-leave-to {
  opacity: 0;
}
</style>
