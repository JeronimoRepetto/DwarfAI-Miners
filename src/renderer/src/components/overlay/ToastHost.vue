<script setup lang="ts">
/*
 * Where toasts show (#635), the design's `.dm-toasts`: above everything else and never in the
 * pointer's way, announced politely without taking focus. Each rises 6px in and leaves 4px down
 * after 2.6s (motion.md, Overlays), transform and opacity only.
 *
 * In the app a toast is centred on the page column, 56px from its bottom, whatever raised it
 * (PANEL-QUESTIONS 10, PO ruling 2026-09-27; decision log, Toast position). The host stands inside
 * that column, its containing block, so it never covers the painting, the dwarfs or the
 * MessagePanel's composer. The old window-wide host is not in the design and is gone.
 */
import ToastCard from './ToastCard.vue'
import { useToasts } from '../../composables/useToasts'

const { toasts } = useToasts()
</script>

<template>
  <TransitionGroup tag="div" name="dm-toast-pop" class="dm-toasts" role="status" aria-live="polite">
    <ToastCard v-for="toast in toasts" :key="toast.id" :text="toast.text" :icon="toast.icon" />
  </TransitionGroup>
</template>

<style scoped>
.dm-toasts {
  display: grid;
  position: absolute;
  left: 50%;
  bottom: 56px;
  transform: translateX(-50%);
  gap: 8px;
  z-index: var(--z-toast);
  justify-items: center;
  pointer-events: none;
}
.dm-toast-pop-enter-active {
  transition:
    transform var(--dur-base) var(--ease-out),
    opacity var(--dur-base) var(--ease-out);
}
.dm-toast-pop-leave-active {
  transition:
    transform var(--dur-fast) var(--ease-in),
    opacity var(--dur-fast) var(--ease-in);
}
.dm-toast-pop-enter-from {
  opacity: 0;
  transform: translateY(var(--rise));
}
.dm-toast-pop-leave-to {
  opacity: 0;
  transform: translateY(4px);
}
</style>
