<script setup lang="ts">
import { computed } from 'vue'
import { NUGGET_SRC } from '../../lib/art'
import { pileLayout, pileScale } from '../../lib/vault/nuggetPile'
import { orePileLabel } from '../../lib/presentation'
import { formatUnits, materialUnits } from '../../lib/vault/vault'
import type { Material } from '../../types'

/**
 * One mound of ONE material — the painted replacement for the CSS heap a real
 * user could only describe as grey balls.
 *
 * A mine's vault gets one of these per material it has actually produced, never
 * a single blended heap: materials do not convert into one another (see #22),
 * and a shared pile would be the picture of exactly the exchange the design
 * refuses. Coal sits beside gold here the way it sits beside gold in the
 * ledger — separate, labelled, and counted at its own grain size.
 *
 * Everything with a decision in it lives in lib/: nuggetPile owns where each
 * stone goes and how many are worth drawing, vault owns the arithmetic, and
 * presentation owns the words. This component measures nothing and decides
 * nothing; it mirrors those results into style.
 */
const props = defineProps<{
  material: Material
  /** Tokens accrued in THIS material alone — never a total across materials. */
  tokens: number
  /**
   * Identifies the pile, so its jitter is its own and stays put between polls.
   * The mine id is what callers pass; the material is appended here.
   */
  seed: string
}>()

const units = computed(() => materialUnits(props.tokens, props.material))
const nuggets = computed(() => pileLayout(`${props.seed}:${props.material}`, units.value))
/* Past the mound's capacity the count stops being drawable and gets printed. */
const overflowing = computed(() => units.value > nuggets.value.length)
const moundScale = computed(() => pileScale(units.value))
const label = computed(() => orePileLabel(props.material, props.tokens))
const nuggetSrc = computed(() => NUGGET_SRC[props.material])
</script>

<template>
  <!--
    role="img" with its own name: the mound is one recognisable thing, and the
    nuggets inside it are brush strokes, not a list a screen reader should walk.
    `title` gives a pointer user the same sentence — the affordance the owner
    found missing was simply being told what the heap is and how much it holds.
  -->
  <div
    class="ore-mound"
    :data-material="material"
    role="img"
    :title="label"
    :aria-label="label"
    :style="{ '--mound-scale': moundScale }"
  >
    <img
      v-for="nugget in nuggets"
      :key="nugget.key"
      class="nugget"
      :src="nuggetSrc"
      alt=""
      aria-hidden="true"
      draggable="false"
      :style="{
        left: `${nugget.x}%`,
        bottom: `${nugget.y}%`,
        zIndex: nugget.zIndex,
        rotate: `${nugget.rotation}deg`,
        scale: nugget.scale
      }"
    />
    <span v-if="overflowing" class="pile-count" aria-hidden="true">{{ formatUnits(units) }}</span>
  </div>
</template>

<style scoped>
/*
 * The box the mound is laid out inside. Its width is six nugget slots, so a
 * full bottom row exactly spans it; nuggets are wider than their slot on
 * purpose, which is what makes the row read as stones shoulder to shoulder
 * rather than a spaced-out sequence. Overflow is visible because the peak and
 * the outermost stones deliberately sit slightly proud of the box.
 */
.ore-mound {
  position: relative;
  flex: none;
  /*
    Deliberately narrow: a long-lived project can hold all six materials at
    once (coal from the backfill plus every tier it grew through), and six of
    these have to stand side by side inside a cave that is about 428px wide.
  */
  width: 48px;
  height: 34px;
  /* Grows past the render cap, so a very rich mine still reads as richer. */
  scale: var(--mound-scale, 1);
  transform-origin: 50% 100%;
}
.nugget {
  position: absolute;
  width: 12px;
  height: auto;
  /* `left` is the centre of the stone; the individual transform properties
     compose as translate -> rotate -> scale, so the per-nugget tilt and size
     set inline never fight this. */
  translate: -50% 0;
  filter: drop-shadow(0 1px 2px #000000b3);
  user-select: none;
}
/*
 * The count past the cap. A mine can mine hundreds of thousands of nuggets and
 * the mound stops at twenty-one, so the number is what carries the rest of the
 * growth — printed over the peak where the pile stops.
 */
.pile-count {
  position: absolute;
  z-index: 10;
  bottom: 100%;
  left: 50%;
  padding: 0 4px;
  border-radius: 7px;
  color: var(--ink);
  background: #15100be6;
  font-size: 9px;
  font-weight: 700;
  white-space: nowrap;
  translate: -50% 0;
}
</style>
