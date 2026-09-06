<script setup lang="ts">
import { onBeforeUnmount } from 'vue'
import { PANEL_MOTION_EASING, PANEL_MOTION_MS, panelKeyframes } from '../../lib/shell/panelMotion'

const props = defineProps<{ axis?: 'horizontal' | 'vertical' }>()
const emit = defineEmits<{ leave: [completion: Promise<void>] }>()
const media = window.matchMedia?.('(prefers-reduced-motion: reduce)')
const active = new Map<Element, () => void>()

function finish(element: Element): void {
  active.get(element)?.()
}

function run(element: Element, done: () => void, leaving: boolean): void {
  finish(element)
  const panel = element as HTMLElement
  panel.inert = leaving
  if (media?.matches || !panel.animate) {
    done()
    return
  }
  let resolve!: () => void
  if (leaving)
    emit(
      'leave',
      new Promise<void>((complete) => {
        resolve = complete
      })
    )
  const animation = panel.animate(panelKeyframes(leaving, props.axis === 'vertical'), {
    duration: PANEL_MOTION_MS,
    easing: PANEL_MOTION_EASING,
    fill: 'both'
  })
  const complete = (): void => {
    if (active.get(element) !== complete) return
    active.delete(element)
    animation.cancel()
    done()
    resolve?.()
  }
  active.set(element, complete)
  void animation.finished.then(complete, complete)
}

function enter(element: Element, done: () => void): void {
  run(element, done, false)
}
function leave(element: Element, done: () => void): void {
  run(element, done, true)
}
function reduceMotion(): void {
  if (media?.matches) for (const complete of active.values()) complete()
}
media?.addEventListener('change', reduceMotion)
onBeforeUnmount(() => {
  media?.removeEventListener('change', reduceMotion)
  for (const complete of active.values()) complete()
})
</script>

<template>
  <Transition
    :css="false"
    @enter="enter"
    @leave="leave"
    @enter-cancelled="finish"
    @leave-cancelled="finish"
    @after-leave="finish"
  >
    <slot />
  </Transition>
</template>
