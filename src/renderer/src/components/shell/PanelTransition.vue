<script setup lang="ts">
import { onBeforeUnmount } from 'vue'
import {
  PANEL_MOTION_EASING,
  PANEL_MOTION_MS,
  PANEL_MOTION_WATCHDOG_MS,
  panelKeyframes
} from '../../lib/shell/panelMotion'

const props = defineProps<{ axis?: 'horizontal' | 'vertical' }>()
const emit = defineEmits<{ leave: [completion: Promise<void>] }>()
const media = window.matchMedia?.('(prefers-reduced-motion: reduce)')
const active = new Map<Element, () => void>()

function finish(element: Element): void {
  active.get(element)?.()
}

function releaseAll(): void {
  for (const complete of [...active.values()]) complete()
}

function run(element: Element, done: () => void, leaving: boolean): void {
  finish(element)
  const panel = element as HTMLElement
  panel.inert = leaving
  // A hidden window cannot advance the document timeline, so an animation
  // started now would never report itself finished (#266). The panel is not on
  // screen either way, which makes reduced motion's instant path the honest
  // one: nothing to watch, and no leave for the layout queue to wait on.
  if (media?.matches || document.hidden || !panel.animate) {
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
  let watchdog: ReturnType<typeof setTimeout> | undefined
  const complete = (): void => {
    if (active.get(element) !== complete) return
    active.delete(element)
    clearTimeout(watchdog)
    animation.cancel()
    done()
    resolve?.()
  }
  active.set(element, complete)
  // `finished` is the accurate report and stays the first one taken. It is not
  // a guarantee of one, though: a window occluded mid-animation lands the last
  // frame on the compositor and never resolves it, so the watchdog is what
  // makes a leave's completion bounded rather than merely likely (#266).
  watchdog = setTimeout(complete, PANEL_MOTION_WATCHDOG_MS)
  void animation.finished.then(complete, complete)
}

function enter(element: Element, done: () => void): void {
  run(element, done, false)
}
function leave(element: Element, done: () => void): void {
  run(element, done, true)
}
function reduceMotion(): void {
  if (media?.matches) releaseAll()
}
/**
 * The window going away mid-animation ends it here rather than in 300ms (#266).
 *
 * This is the ordinary route out of the bug, and the watchdog is its backstop:
 * Chromium reports occlusion as a visibility change, so the leave is released
 * the moment the timeline that was driving it stops.
 */
function releaseHidden(): void {
  if (document.hidden) releaseAll()
}
media?.addEventListener('change', reduceMotion)
document.addEventListener('visibilitychange', releaseHidden)
onBeforeUnmount(() => {
  media?.removeEventListener('change', reduceMotion)
  document.removeEventListener('visibilitychange', releaseHidden)
  releaseAll()
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
