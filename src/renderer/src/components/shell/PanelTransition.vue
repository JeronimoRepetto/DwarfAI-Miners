<script setup lang="ts">
import { onBeforeUnmount } from 'vue'
import { createBoundedMotion, type MotionAnimate } from '../../lib/shell/boundedMotion'
import { watchReducedMotion } from '../../lib/scene/sceneMotion'
import { panelKeyframes, panelMotionX } from '../../lib/shell/panelMotion'
import type { ShellFoldHold } from '../../composables/useShellFold'

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
   * It answers the two moments apart (#464), because they are two: the fold
   * ending is what the shrink waits on, and main having applied the bounds it
   * was folded for is what may unmount the column. Held on the first alone, a
   * `flex: 1` column repacked the row a whole IPC round trip before the window
   * it is packed into changed.
   *
   * Answering `null` means there is no motion to wait for (reduced motion, a
   * hidden window), which is the instant path the rest of this file takes too.
   */
  hold?: (column: HTMLElement) => ShellFoldHold | null
  /**
   * The engine `createBoundedMotion` runs, for a test to hand in a
   * hand-written fake — production never sets this, and gets the real
   * motion-v import (#566).
   */
  engine?: MotionAnimate
}>()
const emit = defineEmits<{ leave: [completion: Promise<void>] }>()
/**
 * The bounded runner, shared with the shell's fold and the message panel's own
 * window since #389 — the three of them had written #266's deadlines out three
 * times. What this component adds to it is the RETENTION: Vue's `done` is what
 * finally unmounts the column, so it may only be called once the motion the
 * shrink waits on is over.
 */
const motion = createBoundedMotion({ animate: props.engine })
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
  emit('leave', fold.folded)
  const complete = (): void => {
    if (active.get(element) !== complete) return
    active.delete(element)
    done()
  }
  active.set(element, complete)
  void fold.released.then(complete, complete)
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
  const vertical = props.axis === 'vertical'
  // `panelMotionX` reads `--panel-motion-x` off the element itself, so a
  // left-docked shell's mirrored sign (`.shell.edge-left` in App.vue) still
  // reaches a horizontal column the way it did when WAAPI resolved that
  // custom property off the live cascade on its own; a vertical dock never
  // reads it.
  const finished = motion.run(
    panel,
    panelKeyframes(leaving, vertical, vertical ? undefined : panelMotionX(panel))
  )
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
 *
 * The preference comes from `sceneMotion`, which is where the app asks that one
 * query (#71): a query written out here as well would be a third mechanism for
 * one answer, and it is the third that keeps disagreeing with the other two.
 */
function releaseHidden(): void {
  if (document.hidden) releaseAll()
}
const unwatchReduced = watchReducedMotion((reduced) => {
  if (reduced) releaseAll()
})
document.addEventListener('visibilitychange', releaseHidden)
onBeforeUnmount(() => {
  unwatchReduced()
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
