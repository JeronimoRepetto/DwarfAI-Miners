<script setup lang="ts">
/*
 * Valle's top bar "⋯" menu (07 machine 37 `menu-open`; US-VALLE-010; NFR-A11Y-02, NFR-A11Y-14; ISSUE-309): the "⋯" and
 * the menu it opens beneath it, holding "Reset preset". The machine owns whether it is open; this draws it.
 *
 * - "Reset preset" is not offered while a dive or a climb plays: the "⋯" is disabled then (S37.01).
 * - The focus goes to the first item when the menu opens; ↑ ↓ Home End move it; Esc or Tab, and a press outside the menu
 *   and outside the "⋯" itself (which toggles it), close it and change nothing (S37.02).
 * - When the menu closes with the focus nowhere (Esc, a pick), it comes back to the "⋯".
 */
import { nextTick, onBeforeUnmount, shallowRef, watch } from 'vue'
import type { MenuEntry } from '../../lib/overlay/menu'
import ActionButton from '../controls/ActionButton.vue'
import MenuList from '../overlay/MenuList.vue'

const props = defineProps<{
  /** The menu is open (machine 37 `menu-open`). */
  open: boolean
  /** A dive or a climb is not running: "Reset preset" is offered (S37.01). */
  offered: boolean
}>()
const emit = defineEmits<{ toggle: []; reset: []; dismiss: [] }>()

const ITEMS: MenuEntry[] = [{ label: 'Reset preset' }]

const more = shallowRef<InstanceType<typeof ActionButton> | null>(null)
/** The "⋯" button itself, the design's `atoms/button`. */
const moreButton = (): HTMLElement | null => (more.value?.$el as HTMLElement | undefined) ?? null
const menu = shallowRef<HTMLElement | null>(null)
const list = shallowRef<InstanceType<typeof MenuList> | null>(null)

/** A press outside the menu, and outside its own "⋯", closes it (S37.02). */
function pressed(event: PointerEvent): void {
  const target = event.target
  if (!(target instanceof Node)) return
  if (menu.value?.contains(target) || moreButton()?.contains(target)) return
  emit('dismiss')
}

watch(
  () => props.open,
  async (open, was) => {
    if (open) {
      document.addEventListener('pointerdown', pressed, true)
      await nextTick()
      list.value?.focusFirst()
      return
    }
    document.removeEventListener('pointerdown', pressed, true)
    if (!was) return
    await nextTick()
    const active = document.activeElement
    if (active === null || active === document.body) moreButton()?.focus()
  },
  { immediate: true }
)
onBeforeUnmount(() => document.removeEventListener('pointerdown', pressed, true))
</script>

<template>
  <div class="dm-vbar__preset" data-valle-preset-menu>
    <ActionButton
      ref="more"
      class="dm-vbar__more"
      icon="more"
      size="sm"
      title="Preset options"
      haspopup="menu"
      :aria-expanded="open ? 'true' : 'false'"
      :disabled="!offered"
      data-preset-more
      @click="emit('toggle')"
    />
    <div v-if="open" ref="menu" class="dm-vbar__menu" data-preset-menu>
      <MenuList
        ref="list"
        aria-label="Preset options"
        :items="ITEMS"
        @pick="emit('reset')"
        @close="emit('dismiss')"
      />
    </div>
  </div>
</template>

<style scoped>
.dm-vbar__preset {
  position: relative;
}
.dm-vbar__menu {
  position: absolute;
  inset-block-start: 100%;
  inset-inline-start: 0;
  z-index: var(--z-menu);
}
</style>
