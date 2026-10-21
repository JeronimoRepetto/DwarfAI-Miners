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
 * Each dwarf is its own target at its full sprite size (US-VETA-005; 07 machine 24; ISSUE-290): a button, so a click,
 * Enter or Space on it asks for its chat (`dwarf`), and a keyboard stop after its chamber. The hit is the sprite
 * itself: the chamber around it and the crew row between dwarfs take no press, so a press near a dwarf that misses it
 * opens nothing (S24.20). A mouse press does not take the keyboard focus, so it raises no tab. Hovering a dwarf shows
 * its one-line label (`DwarfLabel`), centred on that dwarf on every edge and beyond the raised tab (S24.19); the window
 * holds the label's room before it shows (`labelOn`). The open chat's dwarf is drawn pressed.
 *
 * Arrivals and departures (07 machine 26; ISSUE-292), played by the root's choreography: each dwarf's walk is stamped on
 * its button (`walking`, `data-walk`), so the root moves the whole button (sprite, "?", "z") and nothing inside it
 * moves on its own. Placed but not walked in yet, it is not seen. While walking it plays its idle sheet; once arrived
 * (`arrived`) its status sheet starts from the top, `start-working` first for a working dwarf (decision "Walk-in
 * interim"). Walking out, it turns to face away from the anchor. The chamber's lamp brightens while a dwarf walks in
 * (US-OBS-002.AC06). No sound plays: Veta has none of a mine's or a crew's (NFR-SND-03).
 */
import { t, type DwarfId, type DwarfWire, type MineWire } from '@dwarfai/contracts'
import { computed, ref, watch } from 'vue'
import { INTERIOR_SRC } from '../../lib/art'
import { labelPlace, type LabelBox } from '../../lib/veta/dwarfLabel'
import { portraitMark } from '../../lib/dwarf/portrait'
import { designTierLabel } from '../../lib/presentation'
import { dwarfClips, settledClips } from '../../lib/sprite/dwarfSequence'
import { loopOf, type SpriteClip } from '../../lib/sprite/spriteSheet'
import type { MineTier } from '../../types'
import SpriteStrip from '../dwarf/SpriteStrip.vue'
import DwarfLabel from './DwarfLabel.vue'
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
  /** The dwarf whose chat is risen, drawn pressed; `null` when none of this chamber's is. */
  openDwarf: DwarfId | null
  /** A dwarf's hover label and its name for a screen reader (`dwarfLabels`). */
  labelsOf: (dwarf: DwarfWire) => { tip: string; aria: string }
  /** The window holds the hovered dwarf's label room: it may show. Shown at once when unset. */
  labelOn?: boolean
  /**
   * The dwarf under a resting pointer after a wheel notch moved the strip under it (ISSUE-291), stamped per notch: no
   * pointerenter or pointerleave fires then, so the label follows it from here, or goes when it is not one of these.
   */
  pointerDwarf?: { dwarfId: DwarfId | null; stamp: number }
  /** Each walking dwarf's walk (machine 26): placed and not walked in yet, walking in, walking out. */
  walking?: ReadonlyMap<DwarfId, 'waiting' | 'in' | 'out'>
  /** The dwarfs that walked in: their status sheets start from the top. */
  arrived?: ReadonlySet<DwarfId>
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
  /** A click, Enter or Space on a dwarf's sprite: its chat. */
  dwarf: [dwarfId: DwarfId]
  /** The pointer is on a dwarf, or on none of this chamber's. */
  dwarfHover: [dwarfId: DwarfId | null]
}>()

/** The dwarf under the pointer, whose label shows. */
const hovered = ref<DwarfId | null>(null)
const crewRef = ref<HTMLElement | null>(null)
const tabRef = ref<HTMLElement | null>(null)
const labelStyle = ref<Record<string, string>>({})

const hoveredDwarf = computed(() => props.dwarfs.find((d) => d.id === hovered.value) ?? null)

/** A box in the chamber's own pixels: the crew row's offset plus the part's in it. */
function boxOf(part: HTMLElement, within: HTMLElement | null): LabelBox {
  return {
    x: (within?.offsetLeft ?? 0) + part.offsetLeft,
    y: (within?.offsetTop ?? 0) + part.offsetTop,
    width: part.offsetWidth,
    height: part.offsetHeight
  }
}

function hoverDwarf(dwarfId: DwarfId | null, event?: PointerEvent): void {
  const was = hovered.value
  hoverOn(dwarfId, event?.currentTarget instanceof HTMLElement ? event.currentTarget : null)
  if (dwarfId === null && was === null) return
  emit('dwarfHover', dwarfId)
}

/** The label goes to `dwarfId` (placed by its sprite `sprite`), or away with `null`. */
function hoverOn(dwarfId: DwarfId | null, sprite: HTMLElement | null): void {
  if (dwarfId !== null && sprite !== null) {
    const tab = tabRef.value
    const tabBox =
      tab === null
        ? null
        : { x: tab.offsetLeft, y: tab.offsetTop, width: tab.offsetWidth, height: tab.offsetHeight }
    labelStyle.value = labelPlace(props.side, boxOf(sprite, crewRef.value), tabBox)
  }
  hovered.value = dwarfId
}

// A wheel notch: the root already knows the dwarf now under the pointer; this chamber shows its label or drops its own.
watch(
  () => props.pointerDwarf?.stamp,
  () => {
    const dwarfId = props.pointerDwarf?.dwarfId ?? null
    const sprite =
      dwarfId === null
        ? null
        : (crewRef.value?.querySelector<HTMLElement>(`[data-dwarf-id="${dwarfId}"]`) ?? null)
    hoverOn(sprite === null ? null : dwarfId, sprite)
  }
)

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

const walkOf = (dwarf: DwarfWire): 'waiting' | 'in' | 'out' | undefined =>
  props.walking?.get(dwarf.id)

/** A dwarf walking in brightens its chamber's lamp (US-OBS-002.AC06). */
const arriving = computed(() =>
  props.dwarfs.some((d) => {
    const walk = walkOf(d)
    return walk === 'waiting' || walk === 'in'
  })
)

/**
 * The sheet a dwarf plays: its idle sheet while it walks; once it walked in, its status sheet from the top
 * (`start-working` first for a working dwarf); otherwise the sheet its Host status plays. A worker asleep is held on one
 * frame.
 */
function clipsOf(dwarf: DwarfWire): readonly SpriteClip[] {
  const asleep = dwarf.status === 'asleep'
  const working = dwarf.status === 'working'
  if (walkOf(dwarf) !== undefined) return settledClips(dwarf.rank, false, false)
  const clips =
    props.arrived?.has(dwarf.id) === true && !asleep
      ? dwarfClips(dwarf.rank, false, undefined, working, undefined, true)
      : settledClips(dwarf.rank, asleep, working)
  if (!asleep || dwarf.rank === 'foreman') return clips
  return [loopOf({ ...clips[0]!.sheet, frames: 1 })]
}

/** Mirrored to face right, as a dwarf with no station is; walking out it turns away from the anchor. */
function facesRight(dwarf: DwarfWire): boolean {
  return !(walkOf(dwarf) === 'out' && props.reverse && !props.vertical)
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
      :class="{ 'is-lit': attention || arriving }"
      aria-hidden="true"
      data-veta-lamp
    />
    <div ref="crewRef" class="veta-chamber__crew">
      <button
        v-for="dwarf in crew"
        :key="dwarf.id"
        type="button"
        class="veta-dwarf dm-focus-inset"
        :aria-label="labelsOf(dwarf).aria"
        :aria-pressed="openDwarf === dwarf.id ? 'true' : 'false'"
        :data-status="dwarf.status"
        :data-dwarf-id="dwarf.id"
        :data-walk="walkOf(dwarf)"
        data-veta-dwarf
        @mousedown.prevent
        @click="emit('dwarf', dwarf.id)"
        @pointerenter="hoverDwarf(dwarf.id, $event)"
        @pointerleave="hoverDwarf(null)"
      >
        <SpriteStrip :clips="clipsOf(dwarf)" :phase-clips="1" :flip="facesRight(dwarf)" />
        <span v-if="dwarf.status === 'asking'" class="veta-dwarf__ask" data-veta-ask>{{
          portraitMark('asking')
        }}</span>
        <span v-else-if="dwarf.status === 'asleep'" class="veta-dwarf__z" data-veta-z>{{
          portraitMark('asleep')
        }}</span>
      </button>
    </div>
    <DwarfLabel
      v-if="hoveredDwarf !== null"
      :text="labelsOf(hoveredDwarf).tip"
      :side="side"
      :place="labelStyle"
      :on="labelOn ?? true"
      :data-dwarf-id="hoveredDwarf.id"
    />
    <div
      ref="tabRef"
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

/* `.dm-vdwarf`: the sprite at 1:1, a button with no chrome of its own; its brass underline on hover and while its chat
   is open. */
.veta-dwarf {
  position: relative;
  display: block;
  flex: none;
  width: 36px;
  height: 38px;
  padding: 0;
  margin: 0;
  font: inherit;
  color: inherit;
  cursor: pointer;
  background: none;
  border: 0;
}

/* Placed for its walk-in, not walked in yet: unseen until its motion takes it from the chamber's far end. */
.veta-dwarf[data-walk='waiting'] {
  opacity: 0;
}

.veta-dwarf::after {
  position: absolute;
  right: 6px;
  bottom: -3px;
  left: 6px;
  height: 2px;
  content: '';
  background: var(--brass);
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease-step);
}

.veta-dwarf:hover::after {
  opacity: 0.6;
}

.veta-dwarf[aria-pressed='true']::after {
  opacity: 1;
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
