<script setup lang="ts">
/*
 * The redesign's icon atom (#635), `atoms/icon` in the design: one glyph from the registry, on
 * its 16x16 grid, shown at 1x (16px) or 2x (32px) only, because whole scales keep every pixel
 * square. Decorative: the control holding it carries the name. What it draws is the registry's
 * (lib/icon); this only paints it.
 */
import { computed } from 'vue'
import type { IconName } from '../../lib/icon/iconGrids'
import { icons } from '../../lib/icon/iconRegistry'

const props = withDefaults(
  defineProps<{ name: IconName; scale?: 1 | 2; tone?: 'danger' | 'dim' | 'ok' }>(),
  { scale: 1, tone: undefined }
)

const drawn = computed(() => icons.lookup(props.name))
const classes = computed(() => [
  'dm-icon',
  'dm-icon--x' + props.scale,
  ...(props.tone ? ['dm-icon--' + props.tone] : [])
])
</script>

<template>
  <span :class="classes" aria-hidden="true">
    <img v-if="drawn.kind === 'image'" :src="drawn.src" alt="" />
    <svg v-else viewBox="0 0 16 16" shape-rendering="crispEdges">
      <rect
        v-for="run in drawn.runs"
        :key="run.x + ',' + run.y"
        :x="run.x"
        :y="run.y"
        :width="run.width"
        height="1"
        :class="run.className"
      />
    </svg>
  </span>
</template>

<style scoped>
/* The design's icon.css, rule for rule: each palette class paints one token, and a tone repaints some. */
.dm-icon {
  display: inline-grid;
  flex: none;
  line-height: 0;
  place-items: center;
}
.dm-icon--x1 {
  width: 16px;
  height: 16px;
}
.dm-icon--x2 {
  width: 32px;
  height: 32px;
}
.dm-icon svg,
.dm-icon img {
  width: 100%;
  height: 100%;
  image-rendering: pixelated;
  shape-rendering: crispEdges;
}
.dm-icon .c-o {
  fill: var(--rock-lo);
}
.dm-icon .c-h {
  fill: var(--parch-hi);
}
.dm-icon .c-p {
  fill: var(--parchment);
}
.dm-icon .c-q {
  fill: var(--parch-lo);
}
.dm-icon .c-y {
  fill: var(--brass-hi);
}
.dm-icon .c-b {
  fill: var(--brass);
}
.dm-icon .c-B2 {
  fill: var(--brass-lo);
}
.dm-icon .c-g {
  fill: var(--gold);
}
.dm-icon .c-G2 {
  fill: var(--gold-lo);
}
.dm-icon .c-s {
  fill: var(--steel-hi);
}
.dm-icon .c-m {
  fill: var(--steel);
}
.dm-icon .c-S2 {
  fill: var(--steel-lo);
}
.dm-icon .c-w {
  fill: var(--wood-hi);
}
.dm-icon .c-r {
  fill: var(--danger);
}
.dm-icon .c-R2 {
  fill: var(--danger-lo);
}
.dm-icon .c-n {
  fill: var(--ok);
}
.dm-icon .c-i {
  fill: var(--info);
}
.dm-icon .c-k {
  fill: var(--rock-hi);
}
.dm-icon--danger .c-h,
.dm-icon--danger .c-p {
  fill: var(--danger-hi);
}
.dm-icon--danger .c-q {
  fill: var(--danger);
}
.dm-icon--dim .c-h,
.dm-icon--dim .c-p,
.dm-icon--dim .c-q,
.dm-icon--dim .c-b,
.dm-icon--dim .c-y,
.dm-icon--dim .c-B2 {
  fill: var(--steel-lo);
}
.dm-icon--ok .c-h,
.dm-icon--ok .c-p,
.dm-icon--ok .c-q {
  fill: var(--ok);
}
</style>
