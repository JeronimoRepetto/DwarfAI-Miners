<script setup lang="ts">
/*
 * One live column of the Control-room mosaic (ISSUE-298, S-034-1): the Panel's own mine column
 * (MineColumn.vue, the candidate ADR-034 Reuse names for N-up use), unchanged, fed a fixture read
 * model, its sprites on a sprite frame clock of its own (`createFrameClock`, the window's real
 * tick source), so the column can pause it (`pause()`, ISSUE-282) and paint its last frame while
 * it is outside the viewport. The mosaic tells it when it is in view (`setInView`); whether that
 * runs the clock is `columnClockRuns`.
 *
 * Counted for the perf case (probe.ts): every tick the clock asks its tick source for, and every
 * sprite frame painted in the column.
 */
import { onBeforeUnmount, onMounted, provide, ref } from 'vue'
import MineColumn from '../../../src/renderer/src/components/scene/MineColumn.vue'
import { FRAME_CLOCK_KEY } from '../../../src/renderer/src/composables/useFramePlayer'
import {
  browserFrameClockEnv,
  createFrameClock
} from '../../../src/renderer/src/lib/sprite/frameClock'
import type { Mine } from '../../../src/renderer/src/types'
import { columnClockRuns } from './degradation'
import {
  animationFrameCount,
  registerColumn,
  stripStyles,
  unregisterColumn,
  type ColumnEntry
} from './probe'

const props = defineProps<{ mine: Mine; index: number; degradation: boolean }>()

const slot = ref<HTMLElement | null>(null)
let entry: ColumnEntry | undefined

const env = browserFrameClockEnv()
const clock = createFrameClock({
  ...env,
  setTimer(tick, ms) {
    if (entry !== undefined) entry.requests++
    return env.setTimer(tick, ms)
  }
})
provide(FRAME_CLOCK_KEY, clock)

const running = ref(true)

/** The mosaic's word on whether any of this column is inside the viewport. */
function setInView(inView: boolean): void {
  const runs = columnClockRuns(props.degradation, inView)
  if (runs === running.value) return
  running.value = runs
  if (entry !== undefined) entry.running = runs
  if (runs) {
    if (entry !== undefined) {
      entry.stylesAtResume = stripStyles(entry.element)
      entry.resumedAtFrame = animationFrameCount()
    }
    clock.resume()
  } else {
    clock.pause()
  }
}
defineExpose({ setInView })

let watcher: MutationObserver | undefined
onMounted(() => {
  const element = slot.value!
  entry = {
    index: props.index,
    element,
    requests: 0,
    frames: 0,
    running: running.value,
    resumedAtFrame: null,
    stylesAtResume: null
  }
  registerColumn(entry)
  watcher = new MutationObserver((changes) => {
    for (const change of changes) {
      if ((change.target as Element).classList?.contains('dm-sprite__strip')) entry!.frames++
    }
  })
  watcher.observe(element, { subtree: true, attributes: true, attributeFilter: ['style'] })
})
onBeforeUnmount(() => {
  watcher?.disconnect()
  unregisterColumn(props.index)
  clock.dispose()
})
</script>

<template>
  <div ref="slot" class="cr-slot" :data-column="index" :data-clock="running ? 'running' : 'paused'">
    <MineColumn :mine="mine" />
  </div>
</template>

<style scoped>
.cr-slot {
  /* The column's height rule reads the shell height (MineColumn.vue); here it is the window's. */
  --shell-h: 100vh;
  flex: 0 0 auto;
  height: 100%;
}
</style>
