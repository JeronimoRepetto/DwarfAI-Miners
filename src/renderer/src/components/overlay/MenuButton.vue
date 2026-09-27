<script setup lang="ts">
/*
 * The ⋯ button and the menu it opens (#635), the live `molecules/menu` in the design. The menu is
 * fixed-position beside the button (placeFloating: below it, aligned to its end, flipped and
 * clamped inside the window), in <body> so no scrolling list clips it. The first enabled item takes
 * focus; picking, Esc or Tab closes and focus returns to the button; a click outside closes without
 * taking focus back; pressing the button again while open closes it (components.md, Menu, As
 * built). It enters from 6px above and leaves 4px up (motion.md, Overlays), transform and opacity
 * only.
 */
import { nextTick, onBeforeUnmount, ref } from 'vue'
import ActionButton from '../controls/ActionButton.vue'
import MenuList from './MenuList.vue'
import { placeFloating, type MenuEntry } from '../../lib/overlay/menu'
import type { ButtonSize } from '../../lib/controls/button'

defineOptions({ inheritAttrs: false })

withDefaults(
  defineProps<{ items: MenuEntry[]; title: string; size?: ButtonSize; disabled?: boolean }>(),
  { size: undefined, disabled: false }
)
const emit = defineEmits<{ pick: [index: number] }>()

const open = ref(false)
const trigger = ref<InstanceType<typeof ActionButton> | null>(null)
const menu = ref<HTMLElement | null>(null)
const place = ref<{ left: number; top: number } | null>(null)

const button = (): HTMLElement | null => (trigger.value?.$el as HTMLElement | undefined) ?? null

function outside(event: PointerEvent): void {
  const target = event.target as Node | null
  if (target && (menu.value?.contains(target) || button()?.contains(target))) return
  close(false)
}

async function show(): Promise<void> {
  open.value = true
  place.value = null
  await nextTick()
  const anchor = button()?.getBoundingClientRect()
  const box = menu.value?.getBoundingClientRect()
  if (anchor && box) {
    place.value = placeFloating(anchor, box, {
      width: window.innerWidth,
      height: window.innerHeight
    })
  }
  document.addEventListener('pointerdown', outside, true)
}

function close(refocus: boolean): void {
  if (!open.value) return
  open.value = false
  document.removeEventListener('pointerdown', outside, true)
  if (refocus) button()?.focus()
}

function toggle(): void {
  if (open.value) close(true)
  else void show()
}

function pick(index: number): void {
  close(true)
  emit('pick', index)
}

onBeforeUnmount(() => document.removeEventListener('pointerdown', outside, true))
</script>

<template>
  <ActionButton
    ref="trigger"
    v-bind="$attrs"
    icon="more"
    :title="title"
    :size="size"
    haspopup="menu"
    :disabled="disabled"
    :aria-expanded="open ? 'true' : 'false'"
    @click="toggle"
  />
  <Teleport to="body">
    <Transition name="dm-menu-pop">
      <div
        v-if="open"
        ref="menu"
        class="dm-menu-float"
        :style="
          place
            ? { left: place.left + 'px', top: place.top + 'px' }
            : { left: '0px', top: '0px', visibility: 'hidden' }
        "
      >
        <MenuList :items="items" autofocus @pick="pick" @close="close(true)" />
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.dm-menu-float {
  position: fixed;
  z-index: var(--z-menu);
}
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
</style>
