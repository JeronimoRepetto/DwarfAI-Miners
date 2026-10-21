<script setup lang="ts">
/*
 * Veta's grip menu (US-VETA-003; 07 machine 22 `menu-open`; ISSUE-288; DS/docs/screens/veta.md, the grip menu): the
 * one menu the grip opens, drawn as the design's menu (`molecules/menu`, `MenuList`): "Open Panel", "Open Valle" once
 * Valle is built, "New dwarf in…" with its ▸ hint, a rule, "Hide window"; never "Mute sounds" (NFR-SND-03).
 * Presentational: the entries are `lib/veta/gripMenu.ts`'s, and its container (`VetaApp`, through `useMinePicker`)
 * carries out what is chosen. ↑ ↓ move and wrap, Home and End jump, Enter picks; Esc or Tab asks to close.
 */
import { computed, ref } from 'vue'
import MenuList from '../overlay/MenuList.vue'
import type { MenuEntry } from '../../lib/overlay/menu'
import type { GripMenuEntry, GripMenuItemId } from '../../lib/veta/gripMenu'

const props = defineProps<{ entries: GripMenuEntry[] }>()
const emit = defineEmits<{ choose: [id: GripMenuItemId]; close: [] }>()

const list = ref<InstanceType<typeof MenuList> | null>(null)

const items = computed<MenuEntry[]>(() =>
  props.entries.map((entry) =>
    entry.kind === 'rule'
      ? { separator: true }
      : {
          label: entry.label,
          icon: entry.icon,
          ...(entry.hint === undefined ? {} : { hint: entry.hint })
        }
  )
)

function pick(index: number): void {
  const entry = props.entries[index]
  if (entry !== undefined && entry.kind === 'item') emit('choose', entry.id)
}

defineExpose({ focusFirst: (): void => list.value?.focusFirst() })
</script>

<template>
  <div class="veta-grip-menu" data-veta-grip-menu>
    <MenuList ref="list" :items="items" @pick="pick" @close="emit('close')" />
  </div>
</template>

<style scoped>
.veta-grip-menu {
  display: inline-block;
}
</style>
