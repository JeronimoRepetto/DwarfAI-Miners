<script setup lang="ts">
import { onBeforeUnmount } from 'vue'
import { createBoundedMotion } from '../../lib/shell/boundedMotion'
import { panelKeyframes } from '../../lib/shell/panelMotion'

const props = defineProps<{
  axis?: 'horizontal' | 'vertical'
  /**
   * The shell's own fold, for a column whose motion is not its own (#388).
   *
   * The three columns of the book stand on ONE amber ground, and it is the
   * ground that moves now: a fade each would be three answers to the question
   * of how wide the shell is, and the window's resize would still be painted as
   * a jump under them. Given this, the column animates nothing — but it is
   * still HELD, because unmounting it before main has shrunk the window repacks
   * the row inside a rectangle that has not changed yet.
   *
   * Answering `null` means there is no motion to wait for (reduced motion, a
   * hidden window), which is the instant path the rest of this file takes too.
   */
  hold?: (column: HTMLElement) => Promise<void> | null
}>()
const emit = defineEmits<{ leave: [completion: Promise<void>] }>()
/**
 * The bounded runner, shared with the shell's fold and the message panel's own
 * window since #389 — the three of them had written #266's deadlines out three
 * times. What this component adds to it is the RETENTION: Vue's `done` is what
 * finally unmounts the column, so it may only be called once the motion the
 * shrink waits on is over.
 */
const motion = createBoundedMotion()
/** The columns this component is holding on its own account, not the runner's. */
const active = new Map<Element, () => void>()

function finish(element: Element): void {
  active.get(element)?.()
  motion.release(element)
}

function releaseAll(): void {
  for (const complete of [...active.values()]) complete()
  motion.releaseAll()
}

/** Retain a column until the shell has finished folding around it (#388). */
function held(element: Element, panel: HTMLElement, done: () => void, leaving: boolean): void {
  const fold = leaving ? props.hold!(panel) : null
  if (fold === null) {
    done()
    return
  }
  emit('leave', fold)
  const complete = (): void => {
    if (active.get(element) !== complete) return
    active.delete(element)
    done()
  }
  active.set(element, complete)
  void fold.then(complete, complete)
}

function run(element: Element, done: () => void, leaving: boolean): void {
  finish(element)
  const panel = element as HTMLElement
  panel.inert = leaving
  if (props.hold !== undefined) {
    held(element, panel, done, leaving)
    return
  }
  // A hidden window cannot advance the document timeline, so an animation
  // started now would never report itself finished (#266). The panel is not on
  // screen either way, which makes reduced motion's instant path the honest
  // one: nothing to watch, and no leave for the layout queue to wait on.
  if (motion.still(panel)) {
    done()
    return
  }
  const finished = motion.run(panel, panelKeyframes(leaving, props.axis === 'vertical'))
  if (leaving) emit('leave', finished)
  const complete = (): void => {
    if (active.get(element) !== complete) return
    active.delete(element)
    done()
  }
  active.set(element, complete)
  void finished.then(complete)
}

function enter(element: Element, done: () => void): void {
  run(element, done, false)
}
function leave(element: Element, done: () => void): void {
  run(element, done, true)
}
/**
 * The window going away mid-animation ends a retained column here rather than
 * in 300ms (#266).
 *
 * The runner releases its own animations on both of these; what it cannot see
 * is a column held by the shell's FOLD, which is somebody else's promise and
 * has no animation of this component's behind it (#388). That is what these two
 * are still for.
 */
const media = window.matchMedia?.('(prefers-reduced-motion: reduce)')
function reduceMotion(): void {
  if (media?.matches) releaseAll()
}
function releaseHidden(): void {
  if (document.hidden) releaseAll()
}
media?.addEventListener('change', reduceMotion)
document.addEventListener('visibilitychange', releaseHidden)
onBeforeUnmount(() => {
  media?.removeEventListener('change', reduceMotion)
  document.removeEventListener('visibilitychange', releaseHidden)
  releaseAll()
  motion.dispose()
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
