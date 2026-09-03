<script setup lang="ts">
import { computed } from 'vue'
import { TRAY_ICON_SRC } from '../../lib/art'
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
  expanded: boolean
}>()

const emit = defineEmits<{ toggle: [] }>()

const direction = computed(() => arrowDirection(props.edge, props.expanded))

/*
 * What this control does, since #153: it closes the SECONDARY panel, and a mine
 * held open beside it stays open — the design's own mine mock is exactly that
 * state. Collapsing the whole shell back into the rail is the app mark's job,
 * at the top of the navigation stack. The name has to stop promising the bigger
 * action, because the arrow no longer takes it.
 */
const label = computed(() => (props.expanded ? 'Close this panel' : 'Open DwarfAI-Miners'))
</script>

<template>
  <button
    class="edge-rail"
    :class="[expanded ? 'is-open' : 'is-closed', `edge-${edge}`]"
    type="button"
    :aria-label="label"
    :aria-expanded="expanded ? 'true' : 'false'"
    @click="emit('toggle')"
  >
    <!--
      The app mark sits at the TOP of the rail, not at its centre: the arrow
      owns the centre, and page 1 of the design source draws them that way on
      both edges. Once the panel is open the mark belongs at the top of the
      navigation column instead, so it is handed over rather than drawn twice.
    -->
    <img v-if="!expanded" class="rail-mark" :src="TRAY_ICON_SRC" alt="" draggable="false" />
    <span class="rail-arrow" :class="`points-${direction}`" aria-hidden="true"></span>
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
.edge-rail.is-closed {
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
 * The arrow is a triangle whose BASE sits against the rail's outer side and
 * whose apex points the way the panel will move — the shape the verified export
 * draws, rather than a glyph in a font that would not be pixel art.
 *
 * It takes the centre of the rail: `margin: auto 0` pushes the app mark to the
 * top and centres this between what is left.
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
