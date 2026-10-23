<script setup lang="ts">
/*
 * Valle's top bar (`organisms/valle-bar`; 07 S28.06, S28.11, S28.21; US-VALLE-001.AC01, .AC05; ISSUE-300): the preset
 * tabs, a tablist whose ← and → move between the presets as a click does, and the mode lever, "▼ Panel" and "▼ Veta",
 * which leave Valle for that mode carrying the chat in focus, as the Panel's lever does (US-SHELL-001), and the "⋯" preset
 * menu holding "Reset preset" (`ValleTopBarMenu`, 07 machine 37; ISSUE-309). The needs-you counter is its issue's (slot).
 * The top bar never moves (07 machine 28, VA3).
 */
import type { DwarfId, MineId, MoveToModeParams } from '@dwarfai/contracts'
import { nextTick, ref, watch } from 'vue'
import type { VallePreset } from '../../lib/valle/preset'
import ValleTopBarMenu from './ValleTopBarMenu.vue'

const props = withDefaults(
  defineProps<{
    preset: VallePreset
    /** The chat in focus, carried by the lever (machine 9), or none. */
    chat: { mineId: string; dwarfId: string } | null
    /** The "⋯" menu is open (machine 37 `menu-open`). */
    menuOpen?: boolean
    /** "Reset preset" is offered: no dive or climb is running (S37.01). */
    offered?: boolean
  }>(),
  { menuOpen: false, offered: true }
)

const emit = defineEmits<{
  tab: [preset: VallePreset]
  arrow: [key: 'ArrowLeft' | 'ArrowRight']
  leave: [move: MoveToModeParams]
  menu: []
  reset: []
  menuDismiss: []
}>()

const TABS: readonly { preset: VallePreset; label: string }[] = [
  { preset: 'control', label: 'Control room' },
  { preset: 'front', label: 'Work front' }
]

const tablist = ref<HTMLElement | null>(null)

function onKey(event: KeyboardEvent): void {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
  event.preventDefault()
  emit('arrow', event.key)
}

// Keyboard focus follows the selected tab when the switch came from a focused tab (roving tabindex).
watch(
  () => props.preset,
  async () => {
    const list = tablist.value
    if (list === null || !list.contains(document.activeElement)) return
    await nextTick()
    list.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus()
  }
)

/**
 * A side of the lever pressed: that mode, carrying the chat in focus as the Panel's lever does (S28.21; S10.04,
 * `leverMove`): a chat whose mine is not known moves with the mode alone.
 */
function leave(mode: 'panel' | 'veta'): void {
  const chat = props.chat
  emit(
    'leave',
    chat === null || chat.mineId === ''
      ? { mode }
      : { mode, mineId: chat.mineId as MineId, dwarfId: chat.dwarfId as DwarfId }
  )
}
</script>

<template>
  <header class="dm-vbar" aria-label="Valle" :data-preset="preset">
    <div ref="tablist" class="dm-vbar__presets" role="tablist" aria-label="Valle preset">
      <button
        v-for="tab in TABS"
        :key="tab.preset"
        type="button"
        role="tab"
        class="dm-vbar__tab"
        :data-preset-tab="tab.preset"
        :aria-selected="tab.preset === preset ? 'true' : 'false'"
        :tabindex="tab.preset === preset ? 0 : -1"
        @click="emit('tab', tab.preset)"
        @keydown="onKey"
      >
        {{ tab.label }}
      </button>
    </div>
    <slot name="counter" />
    <ValleTopBarMenu
      :open="menuOpen"
      :offered="offered"
      @toggle="emit('menu')"
      @reset="emit('reset')"
      @dismiss="emit('menuDismiss')"
    />
    <div class="dm-vbar__mode" aria-label="Mode">
      <span class="dm-vbar__mode-label">MODE</span>
      <button
        type="button"
        class="dm-vbar__lever"
        data-lever="panel"
        title="Back to the Panel"
        @click="leave('panel')"
      >
        ▼ Panel
      </button>
      <button
        type="button"
        class="dm-vbar__lever"
        data-lever="veta"
        title="Fold into Veta"
        @click="leave('veta')"
      >
        ▼ Veta
      </button>
    </div>
  </header>
</template>

<style scoped>
.dm-vbar {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 40px;
  padding: 0 6px;
}
.dm-vbar__presets {
  display: flex;
  gap: 2px;
}
.dm-vbar__tab[aria-selected='true'] {
  font-weight: 700;
  text-decoration: underline;
}
.dm-vbar__mode {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
}
</style>
