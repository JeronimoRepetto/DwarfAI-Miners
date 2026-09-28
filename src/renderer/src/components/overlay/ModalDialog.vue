<script setup lang="ts">
/*
 * A dialog over the window (#635), the live `molecules/dialog` in the design: the scrim, and the
 * card on it. Cancel comes first and holds focus when it opens; Tab is trapped inside and wraps;
 * Esc cancels; focus goes back to whatever held it before (components.md, Dialog, Accessibility).
 * The scrim fades in while the card rises 6px, and both fade out together (motion.md, Overlays),
 * transform and opacity only. In <body>, so no panel's clipping or stacking reaches it.
 *
 * The keys are heard on the document, not on the scrim: a press on the scrim moves the focus out
 * of the dialog (the scrim takes none, and a press there closes nothing), and Esc and the Tab
 * trap must still hold wherever it went. Focus that lands behind the scrim is pulled back in.
 */
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
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

const firstAction = (): HTMLElement | null =>
  scrim.value?.querySelector<HTMLElement>('.dm-dialog__actions button:not(:disabled)') ??
  focusables()[0] ??
  null

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

function focusin(event: FocusEvent): void {
  const target = event.target as Node | null
  if (scrim.value && target && !scrim.value.contains(target)) firstAction()?.focus()
}

function listen(on: boolean): void {
  if (on) {
    document.addEventListener('keydown', keydown, true)
    document.addEventListener('focusin', focusin, true)
  } else {
    document.removeEventListener('keydown', keydown, true)
    document.removeEventListener('focusin', focusin, true)
  }
}

watch(
  () => props.open,
  async (open) => {
    if (open) {
      opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
      await nextTick()
      listen(true)
      firstAction()?.focus()
    } else {
      listen(false)
      opener?.focus()
      opener = null
    }
  },
  { immediate: true }
)

onBeforeUnmount(() => listen(false))
</script>

<template>
  <Teleport to="body">
    <Transition name="dm-dialog-pop">
      <div v-if="open" ref="scrim" class="dm-scrim">
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
