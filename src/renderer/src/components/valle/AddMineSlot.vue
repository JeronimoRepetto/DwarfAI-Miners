<script setup lang="ts">
/*
 * The dashed "Add a mine here" slot after the Control room's last column (`DS/docs/screens/valle.md` Layout, `.dm-vadd`;
 * 07 machine 32; US-VALLE-006; ISSUE-304): a dashed button holding the add icon at 32 px over "Add a mine here".
 * Pressing it opens its menu (S32.04), drawn by the house menu plate (`MenuList`): every mine not in the mosaic with its
 * tier, or disabled with "not enterable", a rule, then "A new project…", the ordinary folder flow (S32.08).
 *
 * - Esc or Tab, a pointer pressed outside the menu and outside the slot, close it, nothing else (S32.07).
 * - Why the last "A new project…" added nothing, in the Mines page's own words, shows under the slot (S32.12).
 */
import type { MineId } from '@dwarfai/contracts'
import { computed, nextTick, onUnmounted, shallowRef, watch } from 'vue'
import type { MenuEntry } from '../../lib/overlay/menu'
import type { SlotEntry } from '../../lib/valle/mosaic'
import PixelIcon from '../icon/PixelIcon.vue'
import MenuList from '../overlay/MenuList.vue'

const props = defineProps<{
  /** The slot's menu, open, or `null`. */
  entries: readonly SlotEntry[] | null
  /** Why the last "A new project…" added nothing, or `null`. */
  notice: string | null
}>()
const emit = defineEmits<{
  open: []
  dismiss: []
  pick: [mineId: MineId]
  'new-project': []
}>()

const items = computed((): MenuEntry[] =>
  (props.entries ?? []).map((entry) => {
    if (entry.kind === 'rule') return { separator: true }
    if (entry.kind === 'new-project') return { label: entry.label }
    return { label: entry.name, hint: entry.note, disabled: entry.disabled }
  })
)

function picked(index: number): void {
  const entry = props.entries?.[index]
  if (entry?.kind === 'mine') emit('pick', entry.mineId)
  else if (entry?.kind === 'new-project') emit('new-project')
}

const root = shallowRef<HTMLElement | null>(null)
const button = shallowRef<HTMLButtonElement | null>(null)
const list = shallowRef<InstanceType<typeof MenuList> | null>(null)

/** A press outside the slot and its menu closes the menu (S32.07). */
function pressed(event: PointerEvent): void {
  const target = event.target
  if (target instanceof Node && root.value?.contains(target)) return
  emit('dismiss')
}

watch(
  () => props.entries !== null,
  async (open, was) => {
    if (open) {
      document.addEventListener('pointerdown', pressed, true)
      await nextTick()
      list.value?.focusFirst()
      return
    }
    document.removeEventListener('pointerdown', pressed, true)
    const active = document.activeElement
    if (was && (active === null || active === document.body)) button.value?.focus()
  },
  { flush: 'post' }
)
onUnmounted(() => document.removeEventListener('pointerdown', pressed, true))
</script>

<template>
  <div ref="root" class="dm-vadd-wrap">
    <button
      ref="button"
      type="button"
      class="dm-vadd"
      aria-haspopup="menu"
      :aria-expanded="entries !== null ? 'true' : 'false'"
      data-valle-add
      @click="entries === null ? emit('open') : emit('dismiss')"
    >
      <span class="dm-vadd__plate">
        <PixelIcon name="add" :scale="2" />
        <span>Add a mine here</span>
      </span>
    </button>
    <div v-if="entries !== null" class="dm-vadd__menu" data-valle-add-menu>
      <MenuList ref="list" :items="items" @pick="picked" @close="emit('dismiss')" />
    </div>
    <p v-if="notice !== null" class="dm-vadd__notice" role="alert">{{ notice }}</p>
  </div>
</template>

<style scoped>
/* `prototype/screens/valle/valle.css` `.dm-vadd`, as `DS/docs/screens/valle.md` Layout reads it. */
.dm-vadd-wrap {
  position: relative;
  display: grid;
  flex: 0 0 max(200px, var(--col-w));
  grid-template-rows: minmax(0, 1fr) auto;
  min-height: 0;
}
.dm-vadd {
  display: grid;
  height: 100%;
  color: var(--ink-faint);
  place-items: center;
  outline: var(--px) dashed var(--wood-hi);
  outline-offset: calc(var(--px) * -1);
}
.dm-vadd:hover {
  color: var(--ink);
  background: var(--hover-wash);
  outline-color: var(--brass-lo);
}
/* The app's focus ring, 4 px outside the frame (NFR-A11Y-01), over the dashed outline; the design's -4px inset ring
   would fail it. */
.dm-vadd:focus-visible {
  outline: var(--px) solid var(--parchment);
  outline-offset: 4px;
}
.dm-vadd__plate {
  display: grid;
  gap: 8px;
  font: var(--fs-section) / 1.2 var(--f-label);
  justify-items: center;
}
.dm-vadd__menu {
  position: absolute;
  inset-block-start: 50%;
  inset-inline: 8px;
  z-index: var(--z-menu);
}
.dm-vadd__notice {
  margin: 4px 0 0;
  color: var(--danger-hi);
}
</style>
