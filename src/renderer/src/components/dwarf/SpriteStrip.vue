<script setup lang="ts">
/*
 * The redesigned sprite atom (#635), `DM.ui.sprite` in the design: a clipping box one cell wide
 * (36x38 at a whole-number scale) over the sheet's whole strip, moved by whole cells so nothing
 * is ever resampled. The frame comes from the one shared frame clock, each frame held for its own
 * sidecar duration, a flat 200ms under reduced motion (motion.md, Sprite frame timing). A looping
 * sheet starts on its phase frame; a one-shot sheet (`once`) plays from frame 0 and holds its last;
 * `still` is a static picture on frame 0 that never touches the clock. Swapping `sheet` keeps the
 * element and restarts the strip in place. Hidden from assistive tech: the dwarf's button or name
 * carries the meaning (components.md, Sprite, Accessibility).
 *
 * `clips` plays a dwarf's whole sequence instead of one sheet (#635): the shift cycle, a lying-down
 * then the sleep. The strip shows whichever clip the clock is on, in the same element, and reports
 * every frame it shows, so the dwarf that owns the sequence keeps time with the frames it hears
 * (its strike and its grind are frames) rather than running a second clock.
 */
import { computed, watch } from 'vue'
import { useFramePlayer } from '../../composables/useFramePlayer'
import {
  SPRITE_FRAME_SIZE,
  loopOf,
  onceOf,
  type SequencePosition,
  type SpriteClip,
  type SpriteSheet
} from '../../lib/sprite/spriteSheet'

const props = withDefaults(
  defineProps<{
    sheet?: SpriteSheet
    /** A sequence to play instead of `sheet`, a clip at a time. */
    clips?: readonly SpriteClip[]
    /** How many leading clips of `clips` its random start frame spans (frameClock, phaseClips). */
    phaseClips?: number
    scale?: number
    flip?: boolean
    still?: boolean
    once?: boolean
  }>(),
  {
    sheet: undefined,
    clips: undefined,
    phaseClips: undefined,
    scale: 1,
    flip: false,
    still: false,
    once: false
  }
)
const emit = defineEmits<{ frame: [position: SequencePosition] }>()

// A whole number only: a fractional scale resamples the pixel art (components.md, Sprite, Avoid).
const scale = computed(() => Math.max(1, Math.round(props.scale)))

const clips = computed<readonly SpriteClip[]>(() => {
  if (props.clips !== undefined) return props.clips
  const sheet = props.sheet!
  // A still picture is its first frame alone: a one-frame strip the clock never schedules.
  if (props.still) return [loopOf({ ...sheet, frames: 1 })]
  return [props.once ? onceOf(sheet) : loopOf(sheet)]
})
const position = useFramePlayer(
  () => clips.value,
  () => ({ phase: true, phaseClips: props.phaseClips })
)
watch(position, (now) => emit('frame', now), { immediate: true })

// The sheet on show: the one given (whole, a still one too), or the clip the sequence is on.
const shown = computed<SpriteSheet>(() =>
  props.clips === undefined
    ? props.sheet!
    : (props.clips[position.value.clip]?.sheet ?? props.clips[0]!.sheet)
)

const cellWidth = computed(() => SPRITE_FRAME_SIZE.width * scale.value)
const cellHeight = computed(() => SPRITE_FRAME_SIZE.height * scale.value)

const boxStyle = computed(() => ({
  width: `${cellWidth.value}px`,
  height: `${cellHeight.value}px`
}))
const stripStyle = computed(() => ({
  width: `${cellWidth.value * shown.value.frames}px`,
  height: `${cellHeight.value}px`,
  transform: `translateX(${-cellWidth.value * position.value.frame}px)`
}))
</script>

<template>
  <span
    class="dm-sprite"
    :class="{ 'dm-sprite--flip': flip, 'dm-sprite--still': still }"
    :style="boxStyle"
    aria-hidden="true"
  >
    <img class="dm-sprite__strip" :src="shown.src" :style="stripStyle" alt="" draggable="false" />
  </span>
</template>

<style scoped>
.dm-sprite {
  position: relative;
  display: block;
  flex: none;
  overflow: hidden;
}
.dm-sprite__strip {
  display: block;
  max-width: none;
  image-rendering: pixelated;
  will-change: transform;
}
/* Sheets are painted facing left; a dwarf facing right is the mirror (interiorMap.ts, #156). */
.dm-sprite--flip {
  transform: scaleX(-1);
}
</style>
