<script setup lang="ts">
/*
 * A Valle zone's menu (07 machine 31 `menu-open`; US-VALLE-009.AC02, .AC04, .AC05, .AC06; NFR-A11Y-02, NFR-A11Y-14;
 * ISSUE-304), aligned below its header's "⋯": the entries `zoneMenu` gives for the preset, drawn by the house menu plate
 * (`MenuList`, `molecules/menu`), rules between the groups.
 *
 * - A disabled item keeps its place in the menu (NFR-A11Y-14); the item shown now reads "✓" at its far end.
 * - The focus goes to the first enabled item when the menu opens; ↑ ↓ Home End move it; Esc or Tab, and a pointer
 *   pressed outside the menu and outside its zone's own "⋯" (which toggles it), close it, nothing else (S31.02).
 */
import { computed, nextTick, onMounted, onUnmounted, shallowRef } from 'vue'
import type { MenuEntry } from '../../lib/overlay/menu'
import type { ZoneMenuEntry, ZoneMenuItemId } from '../../lib/valle/zone'
import MenuList from '../overlay/MenuList.vue'

const props = defineProps<{ entries: readonly ZoneMenuEntry[] }>()
const emit = defineEmits<{ pick: [id: ZoneMenuItemId]; dismiss: [] }>()

const items = computed((): MenuEntry[] =>
  props.entries.map((entry) =>
    entry.kind === 'rule'
      ? { separator: true }
      : {
          label: entry.label,
          disabled: entry.disabled,
          ...(entry.checked ? { hint: '✓' } : {})
        }
  )
)

function picked(index: number): void {
  const entry = props.entries[index]
  if (entry?.kind === 'item') emit('pick', entry.id)
}

const root = shallowRef<HTMLElement | null>(null)
const list = shallowRef<InstanceType<typeof MenuList> | null>(null)

/** A press outside the menu, and outside its zone's "⋯", closes it (S31.02). */
function pressed(event: PointerEvent): void {
  const target = event.target
  if (!(target instanceof Node) || root.value === null || root.value.contains(target)) return
  const more = root.value.closest('[data-valle-zone]')?.querySelector('[data-zone-more]')
  if (more?.contains(target)) return
  emit('dismiss')
}

onMounted(() => {
  document.addEventListener('pointerdown', pressed, true)
  void nextTick(() => list.value?.focusFirst())
})
onUnmounted(() => document.removeEventListener('pointerdown', pressed, true))
</script>

<template>
  <div ref="root" class="dm-vzmenu" data-zone-menu>
    <MenuList
      ref="list"
      aria-label="Zone menu"
      :items="items"
      @pick="picked"
      @close="emit('dismiss')"
    />
  </div>
</template>

<style scoped>
.dm-vzmenu {
  position: absolute;
  inset-block-start: 100%;
  inset-inline-end: 0;
  z-index: var(--z-menu);
}
</style>
