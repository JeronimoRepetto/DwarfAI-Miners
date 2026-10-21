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
 * Its mine tab (07 machine 23; US-VETA-004; ISSUE-289) hangs off it toward the screen (`side`), aligned to its anchored
 * end, and rises when its container says so (`risen`): the container runs machine 23 over the pointer entering and
 * leaving the chamber and the keyboard focus moving in and out of it, so one tab at most is ever risen. The chamber is a
 * keyboard stop (the design's `.dm-chamber`, tabindex 0) whose focus raises its tab, then Tab walks the tab's buttons.
 * The tab floats in the band the window always holds (07 §24 I-22): rising it never widens the strip or moves a dwarf.
 * The chamber body has no click handler: a container, never a target (S23.06).
 *
 * Opening a dwarf's chat (ISSUE-290) is not built: the dwarfs are figures, the chamber's name says who is in it.
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
import MineTab from './MineTab.vue'

const props = defineProps<{
  mine: MineWire
  dwarfs: readonly DwarfWire[]
  attention: boolean
  vertical: boolean
  /** Anchored at the right or bottom end. */
  reverse: boolean
  /** Where its tab rises: always toward the screen, away from the docked edge. */
  side: 'top' | 'bottom' | 'left' | 'right'
  /** Its tab is risen (07 machine 23). */
  risen: boolean
}>()

const emit = defineEmits<{
  /** The pointer entered (`true`) or left (`false`) the chamber, its tab included. */
  hover: [on: boolean]
  /** The keyboard focus moved into (`true`) or out of (`false`) the chamber, its tab included. */
  focus: [on: boolean]
  /** "▢" on its tab. */
  open: []
  /** "+" on its tab. */
  add: []
}>()

/** Focus leaving for an element still inside the chamber (its tab's buttons) is not focus leaving it. */
function focusOut(event: FocusEvent): void {
  const next = event.relatedTarget as Node | null
  if (next !== null && (event.currentTarget as HTMLElement).contains(next)) return
  emit('focus', false)
}

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
    class="veta-chamber m-mat dm-focus-inset"
    :class="{ 'is-tab': risen }"
    role="group"
    tabindex="0"
    :aria-label="label"
    :data-tier="tier"
    :data-orient="vertical ? 'col' : 'row'"
    :data-align="reverse ? 'end' : 'start'"
    :data-side="side"
    :data-attention="attention ? 'true' : 'false'"
    :data-mine-id="mine.id"
    data-veta-chamber
    data-veta-part="chamber"
    @pointerenter="emit('hover', true)"
    @pointerleave="emit('hover', false)"
    @focusin="emit('focus', true)"
    @focusout="focusOut"
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
    <div
      class="veta-chamber__tab"
      :data-risen="risen ? 'true' : 'false'"
      :aria-hidden="risen ? undefined : 'true'"
      data-veta-tab
    >
      <MineTab :mine="mine" @open="emit('open')" @add="emit('add')" />
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

/*
 * `.dm-chamber__tab`: the mine tab hangs off the chamber toward the screen, aligned 2 px past its anchored end; its
 * transparent padding toward the chamber keeps the hover alive between the two. At rest it is hidden 4 px in; risen
 * (`.is-tab`, machine 23's one tab) it shows in place.
 */
.veta-chamber__tab {
  position: absolute;
  z-index: 4;
  visibility: hidden;
  opacity: 0;
  pointer-events: none;
  transition:
    opacity var(--dur-fast) var(--ease-step),
    transform var(--dur-fast) var(--ease-out),
    visibility 0s linear var(--dur-fast);
}
.veta-chamber[data-side='top'] > .veta-chamber__tab {
  bottom: 100%;
  padding-bottom: 4px;
  transform: translateY(4px);
}
.veta-chamber[data-side='bottom'] > .veta-chamber__tab {
  top: 100%;
  padding-top: 4px;
  transform: translateY(-4px);
}
.veta-chamber[data-side='top'][data-align='start'] > .veta-chamber__tab,
.veta-chamber[data-side='bottom'][data-align='start'] > .veta-chamber__tab {
  left: -2px;
}
.veta-chamber[data-side='top'][data-align='end'] > .veta-chamber__tab,
.veta-chamber[data-side='bottom'][data-align='end'] > .veta-chamber__tab {
  right: -2px;
}
.veta-chamber[data-side='left'] > .veta-chamber__tab {
  right: 100%;
  padding-right: 4px;
  transform: translateX(4px);
}
.veta-chamber[data-side='right'] > .veta-chamber__tab {
  left: 100%;
  padding-left: 4px;
  transform: translateX(-4px);
}
.veta-chamber[data-side='left'][data-align='start'] > .veta-chamber__tab,
.veta-chamber[data-side='right'][data-align='start'] > .veta-chamber__tab {
  top: -2px;
}
.veta-chamber[data-side='left'][data-align='end'] > .veta-chamber__tab,
.veta-chamber[data-side='right'][data-align='end'] > .veta-chamber__tab {
  bottom: -2px;
}
/* Risen: after the side rules, so it wins over their resting offset. */
.veta-chamber.is-tab > .veta-chamber__tab.veta-chamber__tab {
  visibility: visible;
  opacity: 1;
  transform: none;
  pointer-events: auto;
  transition-delay: 0s;
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
