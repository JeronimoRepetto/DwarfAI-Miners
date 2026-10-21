<script setup lang="ts">
/*
 * Veta's closed mine entrance (07 machine 20 `no-sessions`, `first-run`; US-VETA-001.AC03, AC04, AC06; US-VETA-011.AC04;
 * `DS/docs/components.md`, Mine entrance; ISSUE-287): what the strip contracts to with no sessions, the island's one
 * click target. A click, Enter or Space activates it: the Panel with no mine (S20.12), or, on first run, where it
 * carries "+", the empty mine picker (S20.13); its container decides which.
 *
 * Only the lantern moves: one slow loop of a few frames the browser plays from keyframes (`lib/veta/lantern.ts`, built
 * by `cssLoop`), with no JavaScript timer and no sprite on the frame clock (NFR-PERF-04). Under reduced motion it holds
 * a steady light. On a left or right edge the entrance swaps width and height, like every part of the island.
 */
import { t } from '@dwarfai/contracts'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { prefersReducedMotion, watchReducedMotion } from '../../lib/scene/sceneMotion'
import {
  LANTERN_CELL,
  LANTERN_FRAME_OPACITY,
  LANTERN_STEADY_OPACITY,
  lanternLoop
} from '../../lib/veta/lantern'
import PixelIcon from '../icon/PixelIcon.vue'

const props = defineProps<{ first: boolean; vertical: boolean }>()
const emit = defineEmits<{ activate: [] }>()

const reduced = ref(prefersReducedMotion())
const loop = computed(() => lanternLoop(reduced.value))
const strip = ref<HTMLElement | null>(null)
let playing: Animation | null = null

/** Plays the loop on the browser's own animation clock; nothing at all when it is steady. */
function play(): void {
  playing?.cancel()
  playing = null
  const element = strip.value
  if (element === null || !loop.value.animated || typeof element.animate !== 'function') return
  const keyframes: Keyframe[] = loop.value.keyframes.map(({ offset, transform, easing }) => ({
    offset,
    transform,
    easing
  }))
  playing = element.animate(keyframes, {
    duration: loop.value.cycleMs,
    iterations: Infinity,
    easing: 'linear'
  })
}

let unwatch: () => void = () => undefined
onMounted(() => {
  play()
  unwatch = watchReducedMotion((next) => {
    reduced.value = next
  })
})
watch(loop, play, { flush: 'post' })
onBeforeUnmount(() => {
  unwatch()
  playing?.cancel()
  playing = null
})

const steadyOpacity = computed(() =>
  props.first ? LANTERN_STEADY_OPACITY.first : LANTERN_STEADY_OPACITY.plain
)

function key(event: KeyboardEvent): void {
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  emit('activate')
}
</script>

<template>
  <button
    type="button"
    class="veta-entrance m-mat"
    :class="{ 'is-vertical': vertical }"
    :data-first="first ? 'true' : 'false'"
    :aria-label="first ? t('veta.entrance.firstRun.label') : t('veta.entrance.label')"
    :title="first ? t('veta.entrance.firstRun.title') : t('veta.entrance.title')"
    data-veta-entrance
    data-veta-part="entrance"
    @click="emit('activate')"
    @keydown="key"
  >
    <span class="veta-entrance__door" aria-hidden="true" />
    <span class="veta-entrance__lamp" aria-hidden="true">
      <span class="veta-entrance__glow" :data-veta-loop="loop.name">
        <span
          v-if="loop.animated"
          ref="strip"
          class="veta-entrance__strip"
          :style="{ width: `${LANTERN_CELL.width * LANTERN_FRAME_OPACITY.length}px` }"
        >
          <span
            v-for="(opacity, at) in LANTERN_FRAME_OPACITY"
            :key="at"
            class="veta-entrance__cell"
            :style="{ opacity }"
          >
            <span class="veta-entrance__light" />
          </span>
        </span>
        <span v-else class="veta-entrance__cell" :style="{ opacity: steadyOpacity }">
          <span class="veta-entrance__light" />
        </span>
      </span>
    </span>
    <span v-if="first" class="veta-entrance__plus" aria-hidden="true" data-veta-plus>
      <PixelIcon name="add" />
    </span>
  </button>
</template>

<style scoped>
/* `.dm-entrance` (DS/docs/components.md, Mine entrance): 72 × 44 with a 2 px margin, rock with a brass-lo edge. */
.veta-entrance {
  --mat-fill: var(--rock);
  --mat-hi: var(--rock-hi);
  --mat-lo: var(--rock-lo);
  --mat-edge: var(--brass-lo);
  position: relative;
  display: block;
  flex: none;
  width: 72px;
  height: 44px;
  margin: var(--px);
  padding: 0;
  border: 0;
  cursor: pointer;
}

.veta-entrance:hover {
  --mat-edge: var(--brass);
}

/* On a side edge the parts swap width and height (US-VETA-002.AC08): the door stays upright, centred. */
.veta-entrance.is-vertical {
  width: 44px;
  height: 72px;
}

.veta-entrance__door {
  position: absolute;
  left: 26px;
  bottom: 2px;
  width: 20px;
  height: 28px;
  background: repeating-linear-gradient(to bottom, var(--wood-lo) 0 4px, var(--rock-lo) 4px 6px);
  box-shadow:
    -4px 0 0 0 var(--wood-hi),
    4px 0 0 0 var(--wood-hi),
    0 -4px 0 0 var(--wood),
    inset 0 2px 0 0 var(--rock-lo);
}

.veta-entrance.is-vertical .veta-entrance__door {
  left: 12px;
}

.veta-entrance__lamp {
  position: absolute;
  top: 10px;
  left: 54px;
  width: 4px;
  height: 6px;
  background: var(--brass-lo);
  box-shadow: 0 -2px 0 0 var(--steel-lo);
}

.veta-entrance.is-vertical .veta-entrance__lamp {
  left: 36px;
  top: 30px;
}

/* The glow over the lamp, its 2 px ring included: a one-cell window over the strip the loop moves. */
.veta-entrance__glow {
  position: absolute;
  left: -2px;
  top: -2px;
  width: 8px;
  height: 10px;
  overflow: hidden;
  pointer-events: none;
}

.veta-entrance__strip {
  display: flex;
  height: 10px;
  will-change: transform;
}

.veta-entrance__cell {
  position: relative;
  display: block;
  flex: none;
  width: 8px;
  height: 10px;
}

.veta-entrance__light {
  position: absolute;
  left: 2px;
  top: 2px;
  width: 4px;
  height: 6px;
  background: var(--brass-hi);
  box-shadow: 0 0 0 2px var(--glow-brass);
}

.veta-entrance__plus {
  position: absolute;
  top: 3px;
  left: 4px;
  display: block;
  line-height: 0;
}
</style>
