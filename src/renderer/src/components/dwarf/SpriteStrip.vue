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
 */
import { computed } from 'vue'
import { useFramePlayer } from '../../composables/useFramePlayer'
import {
  SPRITE_FRAME_SIZE,
  loopOf,
  onceOf,
  type SpriteClip,
  type SpriteSheet
} from '../../lib/sprite/spriteSheet'

const props = withDefaults(
  defineProps<{
    sheet: SpriteSheet
    scale?: number
    flip?: boolean
    still?: boolean
    once?: boolean
  }>(),
  { scale: 1, flip: false, still: false, once: false }
)

// A whole number only: a fractional scale resamples the pixel art (components.md, Sprite, Avoid).
const scale = computed(() => Math.max(1, Math.round(props.scale)))

const clips = computed<readonly SpriteClip[]>(() => {
  const { sheet } = props
  // A still picture is its first frame alone: a one-frame strip the clock never schedules.
  if (props.still) return [loopOf({ ...sheet, frames: 1 })]
  return [props.once ? onceOf(sheet) : loopOf(sheet)]
})
const position = useFramePlayer(() => clips.value, { phase: true })

const cellWidth = computed(() => SPRITE_FRAME_SIZE.width * scale.value)
const cellHeight = computed(() => SPRITE_FRAME_SIZE.height * scale.value)

const boxStyle = computed(() => ({
  width: `${cellWidth.value}px`,
  height: `${cellHeight.value}px`
}))
const stripStyle = computed(() => ({
  width: `${cellWidth.value * props.sheet.frames}px`,
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
    <img class="dm-sprite__strip" :src="sheet.src" :style="stripStyle" alt="" draggable="false" />
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
