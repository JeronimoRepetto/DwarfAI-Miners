<script setup lang="ts">
import { motion } from 'motion-v'
import { computed } from 'vue'
import { TRAY_ICON_SRC } from '../../lib/art'
import type { ShellComposition } from '../../lib/shell/composition'
import { pressHoverVariants } from '../../lib/shell/presence'
import { arrowDirection } from '../../lib/shell/shellNav'
import type { PanelEdge } from '../../types'

/**
 * The closed edge rail, and the arrow that collapses the panel back into it
 * (#90).
 *
 * One component for both states because it is one surface in the design: the
 * `#f6b644` the rail is painted in is the same colour the expanded frame is
 * painted in, and the arrow simply turns round. Splitting them would mean two
 * places to keep the arrow rule in.
 *
 * It decides nothing. The window belongs to main, so a press is reported and the
 * layout that comes back is what gets drawn — a resize the display refused can
 * never leave the rail painted open.
 */
const props = defineProps<{
  edge: PanelEdge
  /**
   * Which of the shell's three compositions is on screen (#156).
   *
   * It used to be handed `expanded` and to work the rest out for itself, which
   * it cannot: whether it is the whole shell depends on whether the navigation
   * stack is drawn beside it, and with a mine held open beyond a closed
   * secondary panel it is. That produced two app marks on one edge, one of them
   * floating in the gap where the amber ground had also stopped being painted.
   */
  composition: ShellComposition
}>()

const emit = defineEmits<{ toggle: [] }>()

/** True only while this rail IS the whole shell: nothing else is drawn. */
const isRail = computed(() => props.composition === 'rail')

/** The SECONDARY panel's state, which is the only thing the arrow reports. */
const expanded = computed(() => props.composition === 'pages')

const direction = computed(() => arrowDirection(props.edge, expanded.value))

/*
 * What this control does, since #153: it closes the SECONDARY panel, and a mine
 * held open beside it stays open — the design's own mine mock is exactly that
 * state. Collapsing the whole shell back into the rail is the app mark's job,
 * at the top of the navigation stack. The name has to stop promising the bigger
 * action, because the arrow no longer takes it.
 */
const label = computed(() => (expanded.value ? 'Close this panel' : 'Open DwarfAI-Miners'))
</script>

<template>
  <button
    class="edge-rail"
    :class="[isRail ? 'is-rail' : 'is-page', `edge-${edge}`]"
    type="button"
    :aria-label="label"
    :aria-expanded="expanded ? 'true' : 'false'"
    @click="emit('toggle')"
  >
    <!--
      The app mark sits at the TOP of the rail, not at its centre: the arrow
      owns the centre, and page 1 of the design source draws them that way on
      both edges. The moment the navigation column is on screen the mark belongs
      at the top of THAT instead, so it is handed over rather than drawn twice —
      which is what the mine-only composition used to do (#156).
    -->
    <img v-if="isRail" class="rail-mark" :src="TRAY_ICON_SRC" alt="" draggable="false" />
    <!--
      The arrow's press and hover feedback (#566) lives on this face and NOT on
      the button above, because the button is the column the fold carries:
      `useShellFold` writes its travel into the root's own inline `transform`
      and measures the root's box, and a gesture there would put motion-v's
      `scale(...)` into that same property — erasing the travel mid-carry and
      skewing the box, on the very press that starts the fold. A transform in
      here lays nothing out and is invisible to both.

      The face fills the rail below the mark, so the hover still answers across
      the column rather than over a 20px triangle, and it is transparent, so the
      arrow is the only thing it visibly grows. The mark stays outside it: it is
      pinned to the top edge, and a grow about the column's centre would push
      it off the window.
    -->
    <motion.span class="rail-face" v-bind="pressHoverVariants">
      <span class="rail-arrow" :class="`points-${direction}`" aria-hidden="true"></span>
    </motion.span>
  </button>
</template>

<style scoped>
.edge-rail {
  display: flex;
  flex: none;
  flex-direction: column;
  align-items: center;
  width: var(--size-rail-width);
  height: 100%;
  padding: 0;
  border: 0;
  color: inherit;
  background: transparent;
  cursor: pointer;
}
/*
 * Painted only while this rail IS the whole shell. Once a page is drawn beside
 * it the shell paints one amber ground under everything, and a second rounded,
 * shadowed surface inside that one reads as a seam rather than as a rail (#156).
 */
.edge-rail.is-rail {
  border-radius: var(--radius-default);
  background: var(--color-rail);
  box-shadow: var(--elevation-5);
}
.rail-mark {
  display: block;
  width: var(--size-icon);
  height: var(--size-icon);
  /* Pixel art: no smoothing between the source pixels at any scale. */
  image-rendering: pixelated;
  user-select: none;
}
/*
 * Takes the free space below the mark that the arrow's own `margin` used to
 * claim directly, and hands it back as a column the arrow centres in the same
 * way — so the arrow stands exactly where it stood before the face existed.
 */
.rail-face {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  align-self: stretch;
  align-items: center;
}
/*
 * The arrow is a triangle whose BASE sits against the rail's outer side and
 * whose apex points the way the panel will move — the shape the verified export
 * draws, rather than a glyph in a font that would not be pixel art.
 *
 * It takes the centre of the rail: the face it sits in pushes the app mark to
 * the top, and `margin: auto 0` centres this in what is left.
 */
.rail-arrow {
  width: 0;
  height: 0;
  margin: auto 0;
  border-top: 11px solid transparent;
  border-bottom: 11px solid transparent;
}
.rail-arrow.points-left {
  border-right: var(--size-rail-width) solid var(--color-cream);
}
.rail-arrow.points-right {
  border-left: var(--size-rail-width) solid var(--color-cream);
}
.edge-rail:focus-visible {
  outline: 2px solid var(--color-cream);
  outline-offset: -2px;
}
</style>
