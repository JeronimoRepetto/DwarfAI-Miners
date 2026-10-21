<script setup lang="ts">
/*
 * One Veta chamber (`DS/docs/components.md`, Mine chamber; `DS/docs/screens/veta.md` V1 item 2; 07 machine 20;
 * US-VETA-001.AC01, AC02; ISSUE-287): a mine at work, trimmed in its tier colour, holding its present dwarfs at their
 * full 36 × 38 sprite size. A container, never a button. A chamber holding an asking dwarf lights its lamp and gets the
 * heavy brass outline, and that dwarf raises "?" (attention level 1); an asleep dwarf shows "z".
 *
 * The dwarfs play on the window's one frame clock (`SpriteStrip`), each on the sheet its Host status plays, a worker
 * asleep held still (only the foreman's sleep is drawn). A status change patches the dwarf in place, its sheet swapped
 * and its marks redrawn, never rebuilding its element (NFR-PERF-03, S20.14). Anchored at the right or bottom end
 * (`reverse`), the latest dwarf is first in DOM order, so a new one goes in at the far end and nothing moves.
 *
 * Opening a dwarf's chat (ISSUE-290) and the mine tab (ISSUE-289) are not built: the dwarfs are figures, the chamber's
 * name says who is in it.
 */
import { t, type DwarfWire, type MineWire } from '@dwarfai/contracts'
import { computed } from 'vue'
import { INTERIOR_SRC } from '../../lib/art'
import { portraitMark } from '../../lib/dwarf/portrait'
import { designTierLabel } from '../../lib/presentation'
import { settledClips } from '../../lib/sprite/dwarfSequence'
import { loopOf, type SpriteClip } from '../../lib/sprite/spriteSheet'
import type { MineTier } from '../../types'
import SpriteStrip from '../dwarf/SpriteStrip.vue'

const props = defineProps<{
  mine: MineWire
  dwarfs: readonly DwarfWire[]
  attention: boolean
  vertical: boolean
  /** Anchored at the right or bottom end. */
  reverse: boolean
}>()

/** A mine not measured yet is drawn on bronze, as the Panel draws it. */
const tier = computed<MineTier>(() => props.mine.tier ?? 'bronze')

const crew = computed(() => (props.reverse ? [...props.dwarfs].reverse() : props.dwarfs))

const label = computed(() => {
  const name = t('veta.chamber.label', {
    name: props.mine.name,
    tier: designTierLabel(tier.value),
    count: props.dwarfs.length
  })
  const asking = props.dwarfs.filter((d) => d.status === 'asking').length
  return asking === 0 ? name : `${name}, ${t('veta.chamber.asking', { count: asking })}`
})

const rockStyle = computed(() => ({ backgroundImage: `url("${INTERIOR_SRC[tier.value]}")` }))

/** The sheet a dwarf plays for its Host status; a worker asleep is held on one frame. */
function clipsOf(dwarf: DwarfWire): readonly SpriteClip[] {
  const asleep = dwarf.status === 'asleep'
  const clips = settledClips(dwarf.rank, asleep, dwarf.status === 'working')
  if (!asleep || dwarf.rank === 'foreman') return clips
  return [loopOf({ ...clips[0]!.sheet, frames: 1 })]
}
</script>

<template>
  <div
    class="veta-chamber m-mat"
    role="group"
    :aria-label="label"
    :data-tier="tier"
    :data-orient="vertical ? 'col' : 'row'"
    :data-align="reverse ? 'end' : 'start'"
    :data-attention="attention ? 'true' : 'false'"
    :data-mine-id="mine.id"
    data-veta-chamber
    data-veta-part="chamber"
  >
    <span class="veta-chamber__rock" :style="rockStyle" aria-hidden="true" />
    <span
      class="veta-chamber__lamp"
      :class="{ 'is-lit': attention }"
      aria-hidden="true"
      data-veta-lamp
    />
    <div class="veta-chamber__crew">
      <span
        v-for="dwarf in crew"
        :key="dwarf.id"
        class="veta-dwarf"
        :data-status="dwarf.status"
        :data-dwarf-id="dwarf.id"
        aria-hidden="true"
        data-veta-dwarf
      >
        <SpriteStrip :clips="clipsOf(dwarf)" :phase-clips="1" flip />
        <span v-if="dwarf.status === 'asking'" class="veta-dwarf__ask" data-veta-ask>{{
          portraitMark('asking')
        }}</span>
        <span v-else-if="dwarf.status === 'asleep'" class="veta-dwarf__z" data-veta-z>{{
          portraitMark('asleep')
        }}</span>
      </span>
    </div>
  </div>
</template>

<style scoped>
/* `.dm-chamber`: 44 px tall, border box, on rock, its 2 px tier trim painted in its 2 px margin. */
.veta-chamber {
  --mat-fill: var(--rock);
  --mat-hi: var(--rock-hi);
  --mat-lo: var(--rock-lo);
  --mat-edge: var(--tier-c, var(--brass-lo));
  position: relative;
  display: flex;
  flex: none;
  box-sizing: border-box;
  height: 44px;
  margin: var(--px);
  padding: 4px 8px 2px 10px;
}

.veta-chamber[data-align='end'] {
  padding: 4px 10px 2px 8px;
}

.veta-chamber[data-orient='col'] {
  width: 44px;
  height: auto;
  padding: 10px 2px 8px;
}

.veta-chamber[data-orient='col'][data-align='end'] {
  padding: 8px 2px 10px;
}

/* Attention level 1: the heavy outline, 4 px of brass on four sides, no corners. */
.veta-chamber[data-attention='true'] {
  --mat-extra:
    0 -4px 0 0 var(--brass), 0 4px 0 0 var(--brass), -4px 0 0 0 var(--brass), 4px 0 0 0 var(--brass);
}

.veta-chamber[data-tier='bronze'] {
  --tier-c: var(--tier-bronze);
}
.veta-chamber[data-tier='copper'] {
  --tier-c: var(--tier-copper);
}
.veta-chamber[data-tier='silver'] {
  --tier-c: var(--tier-silver);
}
.veta-chamber[data-tier='gold'] {
  --tier-c: var(--tier-gold);
}
.veta-chamber[data-tier='uranium'] {
  --tier-c: var(--tier-uranium);
}

.veta-chamber__rock {
  position: absolute;
  inset: 2px;
  background-repeat: no-repeat;
  background-position: 50% 58%;
  image-rendering: pixelated;
  opacity: 0.42;
  pointer-events: none;
}

.veta-chamber__lamp {
  position: absolute;
  top: 4px;
  left: 3px;
  width: 4px;
  height: 6px;
  background: var(--steel-lo);
  box-shadow: 0 -2px 0 0 var(--rock-lo);
  pointer-events: none;
}

.veta-chamber[data-align='end'] .veta-chamber__lamp {
  left: auto;
  right: 3px;
}

.veta-chamber__lamp::after {
  position: absolute;
  inset: 0;
  content: '';
  background: var(--brass-hi);
  box-shadow:
    0 0 0 2px var(--glow-brass),
    0 0 0 4px var(--glow-parch);
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease-step);
}

.veta-chamber__lamp.is-lit::after {
  opacity: 1;
}

.veta-chamber__crew {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: flex-end;
  gap: 4px;
}

.veta-chamber[data-orient='col'] .veta-chamber__crew {
  flex-direction: column;
  align-items: center;
}

/* `.dm-vdwarf`: the sprite at 1:1. */
.veta-dwarf {
  position: relative;
  display: block;
  flex: none;
  width: 36px;
  height: 38px;
}

.veta-dwarf__ask,
.veta-dwarf__z {
  position: absolute;
  pointer-events: none;
}

.veta-dwarf__ask {
  top: -1px;
  right: -5px;
  display: grid;
  place-items: center;
  width: 14px;
  height: 14px;
  font: 400 var(--fs-section) / 1 var(--f-label);
  color: var(--ink-on-light);
  background: var(--brass);
  box-shadow:
    0 -2px 0 0 var(--rock-lo),
    0 2px 0 0 var(--rock-lo),
    -2px 0 0 0 var(--rock-lo),
    2px 0 0 0 var(--rock-lo),
    inset 2px 2px 0 0 var(--brass-hi);
  animation: dm-bob 1s steps(1, end) infinite;
}

.veta-dwarf__z {
  top: -1px;
  right: -2px;
  font: 400 var(--fs-meta) / 1 var(--f-meta);
  color: var(--parch-lo);
  animation: dm-bob 1.6s steps(1, end) infinite;
}

@media (prefers-reduced-motion: reduce) {
  .veta-dwarf__ask,
  .veta-dwarf__z {
    animation: none !important;
  }
}
</style>
