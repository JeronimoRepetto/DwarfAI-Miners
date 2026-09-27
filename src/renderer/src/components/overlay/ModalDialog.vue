<script setup lang="ts">
/*
 * A dialog over the window (#635), the live `molecules/dialog` in the design: the scrim, and the
 * card on it. Cancel comes first and holds focus when it opens; Tab is trapped inside and wraps;
 * Esc cancels; focus goes back to whatever held it before (components.md, Dialog, Accessibility).
 * The scrim fades in while the card rises 6px, and both fade out together (motion.md, Overlays),
 * transform and opacity only. In <body>, so no panel's clipping or stacking reaches it.
 */
import { nextTick, ref, watch } from 'vue'
import DialogCard from './DialogCard.vue'
import { trapTab, type DialogAction } from '../../lib/overlay/dialog'

const props = withDefaults(
  defineProps<{
    open: boolean
    title: string
    actions: DialogAction[]
    danger?: boolean
    wide?: boolean
    typed?: string
  }>(),
  { danger: false, wide: false, typed: undefined }
)
const emit = defineEmits<{ action: [index: number]; cancel: [] }>()

const scrim = ref<HTMLElement | null>(null)
let opener: HTMLElement | null = null

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])'

const focusables = (): HTMLElement[] => [
  ...(scrim.value?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
]

watch(
  () => props.open,
  async (open) => {
    if (open) {
      opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
      await nextTick()
      scrim.value?.querySelector<HTMLElement>('.dm-dialog__actions button')?.focus()
    } else {
      opener?.focus()
      opener = null
    }
  },
  { immediate: true }
)

function keydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    emit('cancel')
    return
  }
  if (event.key !== 'Tab') return
  const all = focusables()
  const at = trapTab(all.length, all.indexOf(document.activeElement as HTMLElement), event.shiftKey)
  event.preventDefault()
  if (at !== undefined) all[at]!.focus()
}
</script>

<template>
  <Teleport to="body">
    <Transition name="dm-dialog-pop">
      <div v-if="open" ref="scrim" class="dm-scrim" @keydown="keydown">
        <DialogCard
          :title="title"
          :actions="actions"
          :danger="danger"
          :wide="wide"
          :typed="typed"
          @action="emit('action', $event)"
          ><slot
        /></DialogCard>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.dm-scrim {
  display: grid;
  position: fixed;
  inset: 0;
  padding: 16px;
  background: var(--scrim);
  z-index: var(--z-dialog);
  place-items: center;
}
.dm-dialog-pop-enter-active,
.dm-dialog-pop-enter-active :deep(.dm-dialog) {
  transition:
    transform var(--dur-base) var(--ease-out),
    opacity var(--dur-base) var(--ease-out);
}
.dm-dialog-pop-leave-active {
  transition: opacity var(--dur-fast) var(--ease-in);
}
.dm-dialog-pop-enter-from,
.dm-dialog-pop-leave-to {
  opacity: 0;
}
.dm-dialog-pop-enter-from :deep(.dm-dialog) {
  transform: translateY(var(--rise));
}
</style>
