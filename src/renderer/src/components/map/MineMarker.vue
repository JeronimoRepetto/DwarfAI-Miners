<script setup lang="ts">
/**
 * One mine on the world map: the design's shared 10px hexagon with a pulsing
 * light, coloured by tier (#136).
 *
 * Deliberately knows nothing except its own mine. Where it stands, whether its
 * tooltip is showing and how long the pointer has rested on it are all MapView's
 * to answer, because all three need the measured map box and only one tooltip
 * can be open at a time.
 */
import { computed } from 'vue'
import { designTierLabel } from '../../lib/presentation'
import type { Mine } from '../../types'

const props = defineProps<{ mine: Mine }>()

const emit = defineEmits<{ open: [mineId: string] }>()

/*
 * The tier the board stamped for DRAWING, which for a project nobody has walked
 * is a provisional bronze (#41). Correct here — a marker is a drawing — and it
 * is why nothing in this component reaches for knownTier or writes anything.
 */
const label = computed(() => {
  const crew = props.mine.dwarfs.length
  const tier = designTierLabel(props.mine.tier)
  return `Enter ${props.mine.name} (${tier} mine, ${crew} ${crew === 1 ? 'agent' : 'agents'} working)`
})
</script>

<template>
  <div class="mine-marker" :data-tier="mine.tier">
    <button class="marker-hit" type="button" :aria-label="label" @click="emit('open', mine.id)">
      <span class="marker-hex" aria-hidden="true"></span>
    </button>
  </div>
</template>

<style scoped>
/*
  Colour identifies the tier, and the five values are the ones measured off the
  design's own marker export (see design-tokens.css). Attribute selectors rather
  than an inline style so a marker cannot be drawn in a colour that is not one
  of the five.
*/
.mine-marker[data-tier='bronze'] {
  --marker-colour: var(--color-marker-bronze);
}
.mine-marker[data-tier='copper'] {
  --marker-colour: var(--color-marker-copper);
}
.mine-marker[data-tier='silver'] {
  --marker-colour: var(--color-marker-silver);
}
.mine-marker[data-tier='gold'] {
  --marker-colour: var(--color-marker-gold);
}
.mine-marker[data-tier='uranium'] {
  --marker-colour: var(--color-marker-uranium);
}
.mine-marker {
  position: absolute;
  /* Centred on its spawn point: the coordinate names the middle of the marker. */
  translate: -50% -50%;
  /* The marker layer around it is click-through; a marker itself is not. */
  pointer-events: auto;
}
/*
  The design gives a 10px marker and says nothing about its hit target. 22px is
  a decision: a 10px target is under half of what a pointer can comfortably hit
  and is invisible to a shaky hand, and the extra padding costs nothing because
  the nearest two spawn points are 2.65% of the map apart.
*/
.marker-hit {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  cursor: pointer;
  background: transparent;
}
.marker-hit:focus-visible {
  outline: 2px solid var(--color-cream);
  outline-offset: 2px;
  border-radius: 50%;
}
.marker-hex {
  width: var(--size-marker-width);
  /* A regular hexagon's height is 2/sqrt(3) of its width, flat-top. */
  height: calc(var(--size-marker-width) * 1.1547);
  clip-path: polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%);
  background: var(--marker-colour);
  /*
    The "pulsing light" the design asks for, as a halo around the hexagon rather
    than a change to the hexagon itself: the shape identifies a mine and the
    colour identifies its tier, so neither may be what flickers.
  */
  animation: marker-pulse 2.4s ease-in-out infinite;
}
.marker-hit:hover .marker-hex {
  scale: 1.15;
}
@keyframes marker-pulse {
  0%,
  100% {
    filter: drop-shadow(0 0 2px var(--marker-colour));
  }
  50% {
    filter: drop-shadow(0 0 7px var(--marker-colour));
  }
}
/*
  Reduced motion holds the light steady instead of removing it, which is the
  accessibility decision the design source proposes for exactly this case:
  preserve state clarity without removing the marker's identity. A marker with
  no light at all would read as a different kind of marker.
*/
@media (prefers-reduced-motion: reduce) {
  .marker-hex {
    animation: none;
    filter: drop-shadow(0 0 4px var(--marker-colour));
  }
  .marker-hit:hover .marker-hex {
    scale: 1;
  }
}
</style>
