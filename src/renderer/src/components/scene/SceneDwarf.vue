<script setup lang="ts">
/*
 * The dwarf in the scene (#635), `molecules/dwarf` in the design: a button standing on its station
 * in image percent, with a selection halo, a name tag shown only on hover, focus or selection,
 * the "?" of an asking dwarf, the "z" of an asleep one, and its one delivery mark. Hover or
 * keyboard focus shows its tooltip card. Replaces DwarfSprite in the mine column.
 *
 * The sprite is the shared atom, SpriteStrip, playing this dwarf's sequence on the window's one
 * frame clock: the element is kept for life and a status change swaps its sheet in place, so a
 * crew never flickers or restarts its swing (components.md, Dwarf in the scene). The sequence is
 * dwarfSequence's; the state, name and mark are lib/scene/sceneDwarf's; the tooltip's words are
 * lib/dwarf/dwarfTip's.
 *
 * The crew's own sounds are noticed here (#330), because this is the one place that knows which
 * frame is showing: the strike and the grind are frames. Which mine and which dwarf a cue came from
 * is the column's to add; whether anything is heard is the audio engine's.
 *
 * The walk is today's (PANEL-QUESTIONS 14): the column walks a dwarf leg by leg and says so
 * (`walking`, `walkMs`); the dwarf plays its idle sheet on the way, its status sheet on arrival
 * (a working dwarf through its pick-up first), makes its footsteps for as long as it walks, and
 * moves by transform alone from where it was first drawn (motion.md). A leaver fades once it has
 * reached the way out, never on a clock (#156).
 *
 * WHAT DID NOT COME OVER FROM DwarfSprite, stated rather than passing unseen: the talk glyph and
 * its expanded full message (the design floats only the "?" over a dwarf; the words are the
 * MessagePanel's), the pick sparks and the strike glow (removed by the PO, PANEL-QUESTIONS 15), the red
 * tint of a selected sprite (the design's brass halo replaces it), and the per-depth and
 * per-column scaling (the design draws every dwarf at 1x, 36 x 38).
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import DwarfTip from '../dwarf/DwarfTip.vue'
import SpriteStrip from '../dwarf/SpriteStrip.vue'
import TooltipCard from '../overlay/TooltipCard.vue'
import { useHoverTip } from '../../composables/useHoverTip'
import { preloadDwarfArt } from '../../lib/art'
import {
  sceneDwarfLabel,
  sceneDwarfMark,
  sceneDwarfResting,
  sceneDwarfStatus
} from '../../lib/scene/sceneDwarf'
import {
  crewEndingSignal,
  crewFrameSignals,
  crewWalkSignal,
  type CrewSoundSignal
} from '../../lib/sprite/crewSound'
import { LEAVING_EXIT_MS } from '../../lib/presentation'
import { DWARF_CREW, DWARF_SHEETS } from '../../lib/sprite/dwarfSheets'
import { dwarfClips, settledClips } from '../../lib/sprite/dwarfSequence'
import type { SequencePosition, SpriteClip } from '../../lib/sprite/spriteSheet'
import type { Dwarf, DwarfKickState, DwarfSendState } from '../../types'

const props = withDefaults(
  defineProps<{
    dwarf: Dwarf
    /** Where it stands, in percent of the painting (its art box has the painting's aspect). */
    x: number
    y: number
    /** Facing as the sheets are painted (left); a dwarf facing right is drawn mirrored. */
    facesLeft: boolean
    /** Paint order, nearer galleries over farther ones. */
    z?: number
    selected?: boolean
    /** It arrived after the column opened: it plays its way into its state. */
    entering?: boolean
    /** The column is walking it (#19); `x`/`y` are then its current leg's end. */
    walking?: boolean
    /** How long the current leg takes. */
    walkMs?: number
    sendState?: DwarfSendState
    kickState?: DwarfKickState
    /** A look forced without the pointer, as the UI kit's own states show it. */
    state?: 'hover'
  }>(),
  {
    z: undefined,
    selected: false,
    entering: false,
    walking: false,
    walkMs: 0,
    sendState: undefined,
    kickState: undefined,
    state: undefined
  }
)

const emit = defineEmits<{
  /** This dwarf was pressed. What that opens is decided above (#159). */
  select: []
  'crew-sound': [signal: CrewSoundSignal]
}>()

// Cheap after the first sprite: every later call is a no-op.
preloadDwarfArt()

const status = computed(() => sceneDwarfStatus(props.dwarf))
const label = computed(() => sceneDwarfLabel(props.dwarf.name, status.value))
const mark = computed(() => sceneDwarfMark(props.sendState, props.kickState))
const resting = computed(() => sceneDwarfResting(props.dwarf))
// Arrival gates the working sequence (#262): a dwarf still walking has arrived at nothing yet.
const arrived = computed(() => props.walking !== true)
// Working and not asking, since an asking dwarf stops (screens/mine.md, W3·2).
const working = computed(() => status.value === 'working')
// At the rock: working and arrived.
const atWork = computed(() => working.value && arrived.value)

/*
 * The sequence. On the first reading a dwarf that was already here when the column opened is drawn
 * settled in its state; an arrival plays its way in. From then on each change of state is a
 * transition from the previous answer on each axis, which is what dwarfClips turns into the
 * getting-up, the lying-down, the picking-up and the setting-down.
 */
const clips = ref<readonly SpriteClip[]>([])
/*
 * A dwarf found at work starts on a random whole frame of its swings, the leading clips of its
 * settled shift (components.md, Sprite, Anatomy); every other sequence takes the clock's own rule.
 */
const phaseClips = ref<number | undefined>(undefined)
// Vue hands the immediate first run an empty list of old values, so the first reading is flagged.
let firstReading = true
watch(
  [resting, working, () => props.dwarf.role, arrived, atWork] as const,
  ([nowResting, nowWorking, role, nowArrived], previous) => {
    const settled = firstReading && !props.entering && nowArrived
    clips.value = settled
      ? settledClips(role, nowResting, nowWorking)
      : dwarfClips(role, nowResting, previous?.[0], nowWorking, previous?.[4], nowArrived)
    const swings = DWARF_SHEETS[role].working === undefined ? undefined : DWARF_CREW[role].swings
    phaseClips.value = settled && nowWorking && !nowResting ? swings : undefined
    firstReading = false
  },
  { immediate: true }
)

/*
 * A position is only a step from the one before it within the SAME sequence: across a swap, clip
 * 0 frame 0 of the idle and of the pick-up are different pictures, so the new sequence is read as
 * a first reading — which is what opens a worker2's grind on its shift's first frame.
 */
let lastClips: readonly SpriteClip[] | undefined
let lastPosition: SequencePosition | undefined
function onFrame(now: SequencePosition): void {
  const previous = lastClips === clips.value ? lastPosition : undefined
  lastClips = clips.value
  lastPosition = now
  if (!atWork.value) return
  for (const signal of crewFrameSignals(props.dwarf.role, clips.value, previous, now)) {
    emit('crew-sound', signal)
  }
}

// The grind stops with the shift that opened it, however the dwarf leaves the rock.
watch(atWork, (working, was) => {
  if (working || was !== true) return
  const signal = crewEndingSignal(props.dwarf.role, 'shift')
  if (signal !== undefined) emit('crew-sound', signal)
})

/*
 * The footsteps, for exactly as long as the column walks this dwarf; `immediate`, because an
 * arrival mounts already walking. Only a walk seen under way ends.
 */
watch(
  () => props.walking === true,
  (walking, was) => {
    const signal = walking
      ? crewWalkSignal(props.dwarf.role)
      : was === true
        ? crewEndingSignal(props.dwarf.role, 'walk')
        : undefined
    if (signal !== undefined) emit('crew-sound', signal)
  },
  { immediate: true }
)

/*
 * Arrived at the way out (#156): a leaver fades once the column has walked it there, never on a
 * clock, and one it never walked (drawn on its way out when the column opened, or under reduced
 * motion) has reached no way out, so it stays drawn idle on its station as before the walk.
 */
const walkedOut = ref(false)
watch(
  () => props.walking === true,
  (walking, was) => {
    if (!walking && was === true && props.dwarf.status === 'leaving') walkedOut.value = true
  }
)
const departed = computed(() => walkedOut.value && props.dwarf.status === 'leaving')

// A dwarf dropping out of the crew between polls takes its grind and its footsteps with it.
onBeforeUnmount(() => {
  for (const cue of ['walk', 'shift'] as const) {
    if (cue === 'walk' && props.walking !== true) continue
    if (cue === 'shift' && !atWork.value) continue
    const signal = crewEndingSignal(props.dwarf.role, cue)
    if (signal !== undefined) emit('crew-sound', signal)
  }
})

const tip = useHoverTip<string>()

function press(): void {
  tip.hide()
  emit('select')
}

/*
 * Where it stood when first drawn is its anchor (`--x`, `--y`, image percent, as the design places
 * it); every step of a walk is a transform from there (`--dx`, `--dy`, in percent of the art box),
 * over the leg's own duration. The anchor never moves, so a walk animates transform alone and a
 * change of destination mid-walk carries on from where the dwarf is.
 */
const anchor = { x: props.x, y: props.y }
const rootStyle = computed(() => ({
  '--x': anchor.x + '%',
  '--y': anchor.y + '%',
  '--dx': String(Math.round((props.x - anchor.x) * 1000) / 1000),
  '--dy': String(Math.round((props.y - anchor.y) * 1000) / 1000),
  '--walk-ms': (props.walking ? props.walkMs : 0) + 'ms',
  '--exit-ms': LEAVING_EXIT_MS + 'ms',
  ...(props.z === undefined ? {} : { zIndex: props.z })
}))
</script>

<template>
  <button
    class="dm-dwarf"
    :class="{
      'is-leaving': dwarf.status === 'leaving',
      'is-departed': departed,
      'is-hover': state === 'hover'
    }"
    type="button"
    :data-dwarf="dwarf.id"
    :data-status="status"
    :aria-pressed="selected ? 'true' : 'false'"
    :aria-label="label"
    :data-mark="mark?.mark"
    :style="rootStyle"
    @click="press"
    @pointerenter="tip.hover(dwarf.id, $event)"
    @pointerleave="tip.leave"
    @pointerdown="tip.press"
    @mousedown.prevent
    @focus="tip.focus(dwarf.id, $event)"
    @blur="tip.hide"
  >
    <span class="dm-dwarf__over">
      <span class="dm-dwarf__ask">?</span>
      <span class="dm-dwarf__z">z</span>
      <span class="dm-dwarf__mark" :title="mark?.title">{{ mark?.glyph }}</span>
      <span class="dm-dwarf__tag">{{ dwarf.name }}</span>
    </span>
    <span class="dm-dwarf__halo"></span>
    <SpriteStrip :clips="clips" :phase-clips="phaseClips" :flip="!facesLeft" @frame="onFrame" />
  </button>
  <!-- In <body>: the dwarf is transformed onto its feet, which would hold a fixed card. -->
  <Teleport to="body">
    <Transition name="dm-tip-pop">
      <TooltipCard v-if="tip.shown.value !== null" :ref="tip.card" :style="tip.style.value">
        <DwarfTip :dwarf="dwarf" />
      </TooltipCard>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* The design's dwarf.css, rule for rule. */
.dm-dwarf {
  display: grid;
  position: absolute;
  left: var(--x);
  top: var(--y);
  padding: 0;
  z-index: 2;
  justify-items: center;
  /*
   * left/top mark the feet's centre, not the box's corner; a walk adds its offset in percent of the
   * art box (a size container), which is 0 at rest.
   */
  transform: translate(calc(var(--dx, 0) * 1cqw), calc(var(--dy, 0) * 1cqh)) translate(-50%, -100%);
  transition: transform var(--walk-ms, 0ms) linear;
}
.dm-dwarf__halo {
  width: 30px;
  height: 6px;
  position: absolute;
  left: 3px;
  bottom: 0;
  margin-bottom: -2px;
  background: var(--glow-brass);
  box-shadow:
    0 -2px 0 0 var(--brass),
    0 2px 0 0 var(--brass),
    -2px 0 0 0 var(--brass),
    2px 0 0 0 var(--brass);
  opacity: 0;
  transform: scaleX(0.6);
  transition:
    opacity var(--dur-fast) var(--ease-step),
    transform var(--dur-fast) var(--ease-out);
}
.dm-dwarf[aria-pressed='true'] .dm-dwarf__halo {
  opacity: 1;
  transform: none;
}
.dm-dwarf:hover .dm-dwarf__halo,
.dm-dwarf.is-hover .dm-dwarf__halo {
  opacity: 0.6;
  transform: none;
}
.dm-dwarf:focus-visible {
  outline-offset: 0;
}
.dm-dwarf__over {
  display: grid;
  min-height: 18px;
  position: absolute;
  left: 50%;
  bottom: 100%;
  gap: 2px;
  margin-bottom: 2px;
  justify-items: center;
  transform: translateX(-50%);
  pointer-events: none;
}
.dm-dwarf__tag {
  padding: 4px 6px;
  font: var(--fs-meta) / 1 var(--f-meta);
  color: var(--parchment);
  background: var(--rock-lo);
  box-shadow: 0 0 0 var(--px) var(--brass-lo);
  white-space: nowrap;
  opacity: 0;
  transform: translateY(3px);
  transition:
    opacity var(--dur-fast) var(--ease-step),
    transform var(--dur-fast) var(--ease-out);
  pointer-events: none;
}
.dm-dwarf[aria-pressed='true'] .dm-dwarf__tag,
.dm-dwarf:hover .dm-dwarf__tag,
.dm-dwarf:focus-visible .dm-dwarf__tag,
.dm-dwarf.is-hover .dm-dwarf__tag {
  opacity: 1;
  transform: none;
}
.dm-dwarf__ask {
  display: none;
  width: 18px;
  height: 18px;
  position: relative;
  font: var(--fs-section) / 1 var(--f-label);
  color: var(--ink-on-light);
  background: var(--brass);
  box-shadow:
    0 -2px 0 0 var(--rock-lo),
    0 2px 0 0 var(--rock-lo),
    -2px 0 0 0 var(--rock-lo),
    2px 0 0 0 var(--rock-lo),
    inset 2px 2px 0 0 var(--brass-hi);
  place-items: center;
  animation: dm-bob 1s steps(1, end) infinite;
}
.dm-dwarf__ask::after {
  content: '';
  width: 4px;
  height: 4px;
  position: absolute;
  left: 7px;
  bottom: -6px;
  background: var(--brass);
  box-shadow:
    0 2px 0 0 var(--rock-lo),
    -2px 0 0 0 var(--rock-lo),
    2px 0 0 0 var(--rock-lo);
}
.dm-dwarf[data-status='asking'] .dm-dwarf__ask {
  display: grid;
}
.dm-dwarf__z {
  display: none;
  font: var(--fs-meta) / 1 var(--f-meta);
  color: var(--parch-lo);
  animation: dm-bob 1.6s steps(1, end) infinite;
}
.dm-dwarf[data-status='asleep'] .dm-dwarf__z {
  display: block;
}
.dm-dwarf__mark {
  display: none;
  padding: 2px 4px;
  font: var(--fs-meta) / 1 var(--f-meta);
  background: var(--rock-lo);
  color: var(--ink-soft);
  box-shadow: 0 0 0 var(--px) var(--wood);
}
.dm-dwarf[data-mark] .dm-dwarf__mark {
  display: block;
}
.dm-dwarf[data-mark='reacted'] .dm-dwarf__mark {
  color: var(--ok);
}
.dm-dwarf[data-mark='failed'] .dm-dwarf__mark {
  color: var(--danger-hi);
}
/* On its way out it takes no presses, and once it has reached the way out it fades (#156). */
.dm-dwarf.is-leaving {
  pointer-events: none;
}
.dm-dwarf.is-departed {
  animation: dm-dwarf-exit var(--exit-ms) linear forwards;
}
@keyframes dm-dwarf-exit {
  from {
    opacity: 1;
  }
  to {
    opacity: 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .dm-dwarf {
    transition: none;
  }
  .dm-dwarf.is-departed {
    animation: none;
    opacity: 0.55;
  }
}
/* The tooltip's entry and exit (motion.md, Overlays): transform and opacity only. */
.dm-tip-pop-enter-active {
  transition:
    transform var(--dur-base) var(--ease-out),
    opacity var(--dur-base) var(--ease-out);
}
.dm-tip-pop-leave-active {
  transition: opacity var(--dur-fast) var(--ease-in);
}
.dm-tip-pop-enter-from {
  opacity: 0;
  transform: translateY(var(--tip-rise));
}
.dm-tip-pop-leave-to {
  opacity: 0;
}
</style>
