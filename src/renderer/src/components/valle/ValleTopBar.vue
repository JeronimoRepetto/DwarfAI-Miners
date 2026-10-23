<script setup lang="ts">
/*
 * Valle's top bar (`organisms/valle-bar`; 07 S28.06, S28.11, S28.21; US-VALLE-001.AC01, .AC05; ISSUE-300): the preset
 * tabs, a tablist whose ← and → move between the presets as a click does, and the mode lever, "▼ Panel" and "▼ Veta",
 * which leave Valle for that mode carrying the chat in focus, as the Panel's lever does (US-SHELL-001), and the "⋯" preset
 * menu holding "Reset preset" (`ValleTopBarMenu`, 07 machine 37; ISSUE-309). The needs-you counter fills the `counter` slot
 * (`NeedsYouCounter`, 07 machine 34; ISSUE-306).
 * The top bar never moves (07 machine 28, VA3).
 */
import type { DwarfId, MineId, MoveToModeParams } from '@dwarfai/contracts'
import { nextTick, ref, watch } from 'vue'
import type { VallePreset } from '../../lib/valle/preset'
import ActionButton from '../controls/ActionButton.vue'
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
  <header class="dm-vbar m-mat" aria-label="Valle" :data-preset="preset">
    <div ref="tablist" class="dm-vbar__tabs" role="tablist" aria-label="Valle preset">
      <button
        v-for="tab in TABS"
        :key="tab.preset"
        type="button"
        role="tab"
        class="dm-vbar__tab m-mat"
        :data-preset-tab="tab.preset"
        :aria-selected="tab.preset === preset ? 'true' : 'false'"
        :tabindex="tab.preset === preset ? 0 : -1"
        @click="emit('tab', tab.preset)"
        @keydown="onKey"
      >
        {{ tab.label }}
      </button>
    </div>
    <ValleTopBarMenu
      :open="menuOpen"
      :offered="offered"
      @toggle="emit('menu')"
      @reset="emit('reset')"
      @dismiss="emit('menuDismiss')"
    />
    <span class="dm-vbar__grow"></span>
    <div class="dm-vbar__ore"><slot name="ore" /></div>
    <slot name="counter" />
    <div class="dm-vbar__lever" role="group" aria-label="Mode">
      <span class="dm-vbar__lever-label" aria-hidden="true">MODE</span>
      <ActionButton
        label="▼ Panel"
        size="sm"
        title="Back to the Panel"
        data-lever="panel"
        @click="leave('panel')"
      />
      <ActionButton
        label="▼ Veta"
        icon="veta"
        size="sm"
        title="Fold into Veta"
        data-lever="veta"
        @click="leave('veta')"
      />
    </div>
  </header>
</template>

<style scoped>
/* `DS` organisms/valle-bar, valle-bar.css: one wood plate, one height, fixed for the life of the screen. */
.dm-vbar {
  --mat-fill: var(--wood);
  --mat-hi: var(--wood-hi);
  --mat-lo: var(--wood-lo);
  --mat-edge: var(--rock-lo);
  display: flex;
  align-items: center;
  gap: 6px;
  height: 52px;
  padding: 0 6px;
  margin: var(--px);
  min-width: 0;
}
.dm-vbar__tabs {
  display: flex;
  gap: 0;
  padding: 4px;
  background: var(--rock);
  box-shadow:
    inset 2px 2px 0 0 var(--rock-lo),
    inset -2px -2px 0 0 var(--wood-hi);
}
.dm-vbar__tab {
  --mat-fill: var(--wood-lo);
  --mat-hi: var(--wood);
  --mat-lo: var(--rock-lo);
  --mat-edge: var(--rock-lo);
  height: 32px;
  margin: var(--px);
  padding: 0 14px;
  font: 400 var(--fs-section) / 1 var(--f-label);
  color: var(--ink-soft);
  white-space: nowrap;
  transition: transform var(--dur-press) var(--ease-step);
}
.dm-vbar__tab:hover {
  --mat-edge: var(--brass-lo);
  color: var(--ink);
}
.dm-vbar__tab:active {
  transform: translateY(var(--px));
}
.dm-vbar__tab[aria-selected='true'] {
  --mat-fill: var(--gold-select);
  --mat-hi: var(--gold);
  --mat-lo: var(--gold-deep);
  --mat-edge: var(--brass-hi);
  color: var(--parch-hi);
}
.dm-vbar__grow {
  flex: 1;
  min-width: 8px;
}
.dm-vbar__ore {
  min-width: 0;
  overflow: hidden;
}
.dm-vbar__ore :deep(.dm-vault) {
  flex-wrap: nowrap;
}
.dm-vbar__lever {
  display: flex;
  align-items: center;
  gap: 0;
  flex: none;
  padding: 2px 4px;
  background: var(--rock);
  box-shadow:
    inset 2px 2px 0 0 var(--rock-lo),
    inset -2px -2px 0 0 var(--wood);
}
.dm-vbar__lever-label {
  padding: 0 6px 0 2px;
  font: 400 var(--fs-meta) / 1 var(--f-meta);
  color: var(--ink-faint);
  letter-spacing: 0.08em;
}
</style>
