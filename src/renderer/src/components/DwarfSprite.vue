<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { DWARF_FRAME_SRC, preloadDwarfArt } from '../lib/art'
import {
  LEAVING_EXIT_MS,
  NEUTRAL_DWARF_FRAME,
  dwarfAnimation,
  isSpriteFlipped,
  statusAnimationClass
} from '../lib/presentation'
import { computeTooltipPlacement } from '../lib/tooltip'
import type { Dwarf } from '../types'
import DwarfTooltip from './DwarfTooltip.vue'
import SpeechBubble from './SpeechBubble.vue'

const props = defineProps<{
  dwarf: Dwarf
  bubbleText?: string
  activating?: boolean
}>()

const emit = defineEmits<{ activate: [] }>()

const hitRef = ref<HTMLButtonElement | null>(null)
const tooltipRef = ref<InstanceType<typeof DwarfTooltip> | null>(null)
const tooltipVisible = ref(false)
const tooltipStyle = ref<{ left: string; top: string }>({ left: '0px', top: '0px' })

/**
 * The tooltip stays mounted at all times (its content never depends on
 * hover), so its rendered size is always available to measure. Only its
 * position and visibility change on hover/focus — clamped inside the panel
 * and flipped below the sprite when it would otherwise clip an edge (see
 * lib/tooltip.ts), which used to make the leftmost foreman's tooltip
 * unreadable.
 */
function showTooltip(): void {
  const anchorEl = hitRef.value
  const tooltipEl = tooltipRef.value?.$el as HTMLElement | undefined
  if (anchorEl && tooltipEl) {
    const placement = computeTooltipPlacement(
      anchorEl.getBoundingClientRect(),
      tooltipEl.getBoundingClientRect(),
      { width: window.innerWidth, height: window.innerHeight }
    )
    tooltipStyle.value = { left: `${placement.left}px`, top: `${placement.top}px` }
  }
  tooltipVisible.value = true
}

function hideTooltip(): void {
  tooltipVisible.value = false
}

// Cheap after the first sprite: every later call is a no-op.
preloadDwarfArt()

const animation = computed(() => dwarfAnimation(props.dwarf.status, props.dwarf.role))
const frameIndex = ref(0)
let timer: ReturnType<typeof setInterval> | undefined

function stopCycle(): void {
  if (timer === undefined) return
  clearInterval(timer)
  timer = undefined
}

// A status change restarts the loop on its first frame, so a dwarf that just
// picked up a task never starts mid-swing.
watch(
  animation,
  (next) => {
    stopCycle()
    frameIndex.value = 0
    if (next.frames.length < 2) return
    timer = setInterval(() => {
      frameIndex.value = (frameIndex.value + 1) % next.frames.length
    }, next.frameMs)
  },
  { immediate: true }
)
onBeforeUnmount(stopCycle)

const frame = computed(() => {
  // A neutral stand covers the pause between the click and the terminal focus.
  if (props.activating === true) return NEUTRAL_DWARF_FRAME
  return animation.value.frames[frameIndex.value] ?? NEUTRAL_DWARF_FRAME
})
const frameSrc = computed(() => DWARF_FRAME_SRC[frame.value])

const isForeman = computed(() => props.dwarf.role === 'foreman')
const rootClasses = computed(() => [
  statusAnimationClass(props.dwarf.status),
  {
    'is-foreman': isForeman.value,
    'is-activating': props.activating,
    'is-flipped': isSpriteFlipped(props.dwarf.status)
  }
])
// The walk-out lasts exactly as long as the runtime keeps a leaving dwarf.
const exitStyle = computed(() => ({ '--exit-ms': `${LEAVING_EXIT_MS}ms` }))
const ariaLabel = computed(
  () =>
    `Open ${props.dwarf.name} (${props.dwarf.role}, ${props.dwarf.provider}) — ${props.dwarf.status}`
)
</script>

<template>
  <div class="dwarf-sprite" :class="rootClasses" :style="exitStyle">
    <SpeechBubble v-if="bubbleText" class="bubble-holder" :text="bubbleText" />
    <button
      ref="hitRef"
      class="dwarf-hit"
      type="button"
      :aria-label="ariaLabel"
      @click="emit('activate')"
      @mouseenter="showTooltip"
      @mouseleave="hideTooltip"
      @focus="showTooltip"
      @blur="hideTooltip"
    >
      <img class="dwarf-frame" :src="frameSrc" alt="" aria-hidden="true" draggable="false" />
      <span
        class="provider-dot"
        :class="`provider-${dwarf.provider}`"
        :title="dwarf.provider"
        aria-hidden="true"
      ></span>
      <span v-if="dwarf.status === 'waiting'" class="zzz" aria-hidden="true">z z z</span>
    </button>
    <span class="dwarf-name">{{ dwarf.name }}</span>
    <DwarfTooltip
      ref="tooltipRef"
      class="tooltip-holder"
      :class="{ 'is-visible': tooltipVisible }"
      :style="tooltipStyle"
      :dwarf="dwarf"
    />
  </div>
</template>

<style scoped>
.dwarf-sprite {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 96px;
}
.dwarf-hit {
  position: relative;
  display: block;
  padding: 0;
  border: 0;
  cursor: pointer;
  background: transparent;
  line-height: 0;
}
.dwarf-hit:focus-visible {
  outline: 2px solid #ffe29c;
  outline-offset: 3px;
  border-radius: 8px;
}
.dwarf-frame {
  display: block;
  width: auto;
  /* All nine poses share one canvas, so a fixed height fixes the width too. */
  height: 100px;
  filter: drop-shadow(0 4px 5px #000a);
  user-select: none;
}
.is-flipped .dwarf-frame {
  scale: -1 1;
}
.is-activating {
  opacity: 0.55;
}
.dwarf-name {
  max-width: 96px;
  margin-top: 2px;
  overflow: hidden;
  color: var(--ink-dim);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/*
 * The art is painted, not tinted: the provider gets its own small badge so the
 * palette of the drawing survives.
 */
.provider-dot {
  position: absolute;
  right: 10px;
  bottom: 4px;
  width: 9px;
  height: 9px;
  border: 1px solid #000000a6;
  border-radius: 50%;
  background: var(--provider-tint, #b9aa91);
  box-shadow: 0 0 6px var(--provider-tint, #b9aa91);
}
.provider-claude {
  --provider-tint: #d97757;
}
.provider-codex {
  --provider-tint: #cfd4d9;
}

/* waiting: Zzz drifting up off the resting pose */
.zzz {
  position: absolute;
  top: -6px;
  right: -2px;
  color: var(--ink-dim);
  font-size: 11px;
  font-style: italic;
  letter-spacing: 0.12em;
  line-height: 1;
  pointer-events: none;
  animation: zzz-float 3.2s ease-in-out infinite;
}

/* leaving: walks toward the exit and fades within the runtime grace window */
.is-leaving {
  animation: walk-out var(--exit-ms, 16000ms) linear forwards;
  pointer-events: none;
}

@keyframes zzz-float {
  0% {
    opacity: 0;
    transform: translateY(4px);
  }
  30% {
    opacity: 0.9;
  }
  70% {
    opacity: 0;
    transform: translateY(-9px);
  }
  100% {
    opacity: 0;
  }
}
@keyframes walk-out {
  0% {
    opacity: 1;
    translate: 0 0;
  }
  85% {
    opacity: 1;
  }
  100% {
    opacity: 0;
    translate: -480px 0;
  }
}

.bubble-holder {
  position: absolute;
  z-index: 20;
  bottom: calc(100% + 2px);
  left: 46%;
}
/*
 * Fixed positioning (not relative to .dwarf-sprite): left/top come from
 * computeTooltipPlacement() in viewport coordinates, so the tooltip can be
 * clamped/flipped inside the panel instead of always centering under the
 * sprite and clipping off-screen near an edge.
 */
.tooltip-holder {
  position: fixed;
  z-index: 30;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.15s;
}
.tooltip-holder.is-visible {
  opacity: 1;
}
</style>
