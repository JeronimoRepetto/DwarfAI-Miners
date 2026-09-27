<script setup lang="ts">
/*
 * The overflow menu's plate (#635), `molecules/menu` in the design: a raised wood plate of rows,
 * each an optional icon, a label and an optional hint, rules between groups and danger last. A
 * menu with menuitems: ↑/↓ move and wrap, Home and End jump, Enter picks, Esc or Tab asks to close.
 * What the items decide is lib/overlay/menu's; MenuButton is what opens this beside its button.
 */
import { nextTick, onMounted, ref } from 'vue'
import PixelIcon from '../icon/PixelIcon.vue'
import {
  firstEnabled,
  isSeparator,
  menuItemClasses,
  menuKeyTarget,
  type MenuEntry,
  type MenuItem
} from '../../lib/overlay/menu'

const props = withDefaults(defineProps<{ items: MenuEntry[]; autofocus?: boolean }>(), {
  autofocus: false
})
const emit = defineEmits<{ pick: [index: number]; close: [] }>()

const root = ref<HTMLElement | null>(null)

function focusItem(index: number | undefined): void {
  if (index === undefined) return
  root.value?.querySelector<HTMLButtonElement>('[data-index="' + index + '"]')?.focus()
}

function keydown(event: KeyboardEvent, index: number): void {
  if (event.key === 'Escape' || event.key === 'Tab') {
    if (event.key === 'Escape') event.preventDefault()
    emit('close')
    return
  }
  const target = menuKeyTarget(props.items, index, event.key)
  if (target === undefined) return
  event.preventDefault()
  focusItem(target)
}

const pick = (index: number, entry: MenuItem): void => {
  if (!entry.disabled) emit('pick', index)
}

onMounted(() => {
  if (props.autofocus) void nextTick(() => focusItem(firstEnabled(props.items)))
})
</script>

<template>
  <div ref="root" class="dm-menu m-mat m-raised" role="menu">
    <template v-for="(entry, index) in items" :key="index">
      <hr v-if="isSeparator(entry)" class="dm-menu__sep m-rule" role="separator" />
      <button
        v-else
        :class="menuItemClasses(entry)"
        type="button"
        role="menuitem"
        :data-index="index"
        :disabled="entry.disabled === true"
        @click="pick(index, entry)"
        @keydown="keydown($event, index)"
      >
        <PixelIcon v-if="entry.icon !== undefined" :name="entry.icon" />{{ entry.label
        }}<span v-if="entry.hint !== undefined" class="dm-menu__hint">{{ entry.hint }}</span>
      </button>
    </template>
  </div>
</template>

<style scoped>
/* The design's menu.css, rule for rule. */
.dm-menu {
  --mat-fill: var(--wood);
  --mat-hi: var(--wood-hi);
  --mat-lo: var(--wood-lo);
  --mat-edge: var(--rock-lo);
  display: grid;
  min-width: 180px;
  padding: 4px;
  z-index: var(--z-menu);
}
.dm-menu__item {
  display: flex;
  min-height: var(--hit-tool);
  gap: 8px;
  padding: 0 10px;
  font: var(--fs-meta) / 1 var(--f-meta);
  color: var(--ink);
  align-items: center;
  text-align: left;
  white-space: nowrap;
}
.dm-menu__item:hover,
.dm-menu__item:focus-visible,
.dm-menu__item.is-hover {
  background: var(--wood-hi);
  color: var(--parch-hi);
  box-shadow: inset 2px 0 0 0 var(--brass);
  outline: none;
}
.dm-menu__item:active,
.dm-menu__item.is-active {
  background: var(--wood-lo);
}
.dm-menu__item:disabled {
  color: var(--ink-faint);
  background: none;
  box-shadow: none;
}
.dm-menu__item--danger {
  color: var(--danger-hi);
}
.dm-menu__item--danger:hover,
.dm-menu__item--danger:focus-visible,
.dm-menu__item--danger.is-hover {
  background: var(--danger-lo);
  color: var(--danger-hi);
  box-shadow: inset 2px 0 0 0 var(--danger);
}
.dm-menu__sep {
  margin: 4px 2px;
}
.dm-menu__hint {
  margin-left: auto;
  padding-left: 12px;
  color: var(--ink-faint);
}
</style>
