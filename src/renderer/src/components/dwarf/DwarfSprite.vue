<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { DWARF_FRAME_SRC, preloadDwarfArt } from '../../lib/art'
import { bubbleRowOffsetPx } from '../../lib/overlay/bubbleLayout'
import {
  kickMarker as kickMarkerFor,
  sendMarker as sendMarkerFor
} from '../../lib/delivery/deliveryVerdict'
import {
  LEAVING_EXIT_MS,
  NEUTRAL_DWARF_FRAME,
  isDwarfSilent,
  isPickImpact,
  isSpriteFlipped,
  sceneDwarfAnimation,
  statusAnimationClass
} from '../../lib/presentation'
import { computeTooltipPlacement } from '../../lib/overlay/tooltip'
import type { Dwarf, DwarfKickState, DwarfSendState } from '../../types'
import DwarfActionBar from './DwarfActionBar.vue'
import DwarfTooltip from './DwarfTooltip.vue'
import SpeechBubble from './SpeechBubble.vue'

const props = defineProps<{
  dwarf: Dwarf
  bubbleText?: string
  /**
   * Which stacked row this bubble draws in when it shares a scene anchor with
   * other dwarfs (issue #43) — `ScenePlacement.shareIndex` from the caller.
   * Omitted or 0 (a dwarf with no anchor to share, or the sole occupant of
   * one) leaves the bubble exactly where it has always been drawn.
   */
  bubbleRow?: number
  activating?: boolean
  sendState?: DwarfSendState
  kickState?: DwarfKickState
  /*
   * The scene props (issue #19). All optional, and all falling back to the
   * behaviour the sprite had before the cave became walkable, so a sprite
   * mounted on its own still animates and faces exactly as it used to.
   */
  /** True while the dwarf is crossing the floor toward its anchor. */
  walking?: boolean
  /** Scene-driven facing: travel direction mid-walk, the anchor's once parked. */
  facesLeft?: boolean
  /** Perspective scale for the depth this dwarf is standing at. */
  depthScale?: number
  /**
   * True when MineScene owns this sprite's position. The scene walks a leaving
   * dwarf to the painted exit itself, so the old fixed `walk-out` slide — which
   * drifts left regardless of where the door is — has to stand down.
   */
  anchored?: boolean
}>()

const emit = defineEmits<{
  activate: []
  'send-text': [payload: { text: string; pressEnter: boolean }]
  kick: []
  /** The user expanded the bubble: the owner must pause its auto-hide (board.hold). */
  'bubble-hold': []
  /** The expanded bubble closed: the owner resumes auto-hide with a fresh TTL (board.release). */
  'bubble-release': []
}>()

const hitRef = ref<HTMLButtonElement | null>(null)
const tooltipRef = ref<InstanceType<typeof DwarfTooltip> | null>(null)
const tooltipVisible = ref(false)
const tooltipStyle = ref<{ left: string; top: string }>({ left: '0px', top: '0px' })

/**
 * Clicking a dwarf opens the icon action bar (see #27) rather than acting
 * immediately: kick, boost, chat, and the old click behaviour (focus the
 * console) each get an icon. Positioned like the tooltip — `fixed`, clamped
 * inside the panel — because the mine's cave clips anything drawn inside it.
 */
const barRef = ref<InstanceType<typeof DwarfActionBar> | null>(null)
const barOpen = ref(false)
const barStyle = ref<{ left: string; top: string }>({ left: '0px', top: '0px' })

async function openBar(): Promise<void> {
  barOpen.value = true
  hideTooltip()
  // One popover at a time: the bar replaces an expanded bubble, mirroring
  // how it replaces the hover tooltip just above.
  collapseBubble()
  await nextTick()
  const anchorEl = hitRef.value
  const barEl = barRef.value?.$el as HTMLElement | undefined
  if (anchorEl && barEl) {
    const placement = computeTooltipPlacement(
      anchorEl.getBoundingClientRect(),
      barEl.getBoundingClientRect(),
      { width: window.innerWidth, height: window.innerHeight }
    )
    barStyle.value = { left: `${placement.left}px`, top: `${placement.top}px` }
  }
  document.addEventListener('click', closeBar)
}

function closeBar(): void {
  barOpen.value = false
  document.removeEventListener('click', closeBar)
}

function toggleBar(): void {
  if (barOpen.value) {
    closeBar()
    return
  }
  void openBar()
}

function openConsole(): void {
  closeBar()
  emit('activate')
}

function sendText(payload: { text: string; pressEnter: boolean }): void {
  // The bar stays open so the delivery verdict has somewhere to land.
  emit('send-text', payload)
}

function kick(): void {
  // Same reasoning as sendText: the bar stays open so the verdict has somewhere to land.
  emit('kick')
}

/**
 * Clicking the bubble swaps it for a fixed panel carrying the whole
 * `lastMessage` (see #26) — positioned like the tooltip and bar, because the
 * cave clips anything absolute inside it. Expanding holds the bubble on the
 * board so the TTL cannot hide it mid-read; every way out of the panel
 * (outside click, Escape, second click, opening the bar, the dwarf leaving)
 * funnels through collapseBubble so the hold is always released.
 */
const expandedRef = ref<HTMLElement | null>(null)
const bubbleExpanded = ref(false)
const expandedStyle = ref<{ left: string; top: string }>({ left: '0px', top: '0px' })

async function expandBubble(): Promise<void> {
  closeBar()
  bubbleExpanded.value = true
  emit('bubble-hold')
  await nextTick()
  const anchorEl = hitRef.value
  const panelEl = expandedRef.value
  if (anchorEl && panelEl) {
    const placement = computeTooltipPlacement(
      anchorEl.getBoundingClientRect(),
      panelEl.getBoundingClientRect(),
      { width: window.innerWidth, height: window.innerHeight }
    )
    expandedStyle.value = { left: `${placement.left}px`, top: `${placement.top}px` }
  }
  document.addEventListener('click', collapseBubble)
  document.addEventListener('keydown', onExpandedKeydown)
}

function collapseBubble(): void {
  if (!bubbleExpanded.value) return
  bubbleExpanded.value = false
  // Releasing grants a fresh full TTL, so the bubble never vanishes the
  // instant it shrinks back (a release on a dropped bubble is a board no-op).
  emit('bubble-release')
  document.removeEventListener('click', collapseBubble)
  document.removeEventListener('keydown', onExpandedKeydown)
}

function onExpandedKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') collapseBubble()
}

function toggleBubble(): void {
  if (bubbleExpanded.value) {
    collapseBubble()
    return
  }
  void expandBubble()
}

// The board drops a held bubble when its dwarf walks out — nothing is left
// to read, so the panel goes with it.
watch(
  () => props.bubbleText,
  (text) => {
    if (!text) collapseBubble()
  }
)

const bubbleLabel = computed(() => `Read the full message from ${props.dwarf.name}`)

/**
 * Row 0 (no prop, or the sole occupant of an anchor) renders no style at all,
 * so the DOM for a lone bubble is byte-for-byte what it was before #43 —
 * only a dwarf actually sharing a rock gets the extra custom property that
 * lifts its bubble clear of its neighbours' (see lib/bubbleLayout.ts).
 */
const bubbleLiftStyle = computed<{ '--bubble-lift': string } | undefined>(() => {
  const offset = bubbleRowOffsetPx(props.bubbleRow ?? 0)
  return offset > 0 ? { '--bubble-lift': `${offset}px` } : undefined
})

onBeforeUnmount(() => {
  document.removeEventListener('click', closeBar)
  document.removeEventListener('click', collapseBubble)
  document.removeEventListener('keydown', onExpandedKeydown)
})

/**
 * The tooltip stays mounted at all times (its content never depends on
 * hover), so its rendered size is always available to measure. Only its
 * position and visibility change on hover/focus — clamped inside the panel
 * and flipped below the sprite when it would otherwise clip an edge (see
 * lib/tooltip.ts), which used to make the leftmost foreman's tooltip
 * unreadable.
 */
function showTooltip(): void {
  const anchorEl = hitRef.value
  const tooltipEl = tooltipRef.value?.$el as HTMLElement | undefined
  if (anchorEl && tooltipEl) {
    const placement = computeTooltipPlacement(
      anchorEl.getBoundingClientRect(),
      tooltipEl.getBoundingClientRect(),
      { width: window.innerWidth, height: window.innerHeight }
    )
    tooltipStyle.value = { left: `${placement.left}px`, top: `${placement.top}px` }
  }
  tooltipVisible.value = true
}

function hideTooltip(): void {
  tooltipVisible.value = false
}

// Cheap after the first sprite: every later call is a no-op.
preloadDwarfArt()

/**
 * Whether this dwarf has produced nothing for its role's whole window (issue
 * #47). Read off the wire figure the provider stamps, against the provider's
 * own windows — the sprite decides nothing about it, it only draws it.
 *
 * Note what this is NOT: a status. `props.dwarf.status` is untouched, so the
 * animation class, the accessible name and every consumer downstream still see
 * a working dwarf. Only the pose changes.
 */
const silent = computed(() => isDwarfSilent(props.dwarf.role, props.dwarf.silentForMs))

const animation = computed(() =>
  sceneDwarfAnimation(props.dwarf.status, props.dwarf.role, props.walking === true, silent.value)
)
const frameIndex = ref(0)
let timer: ReturnType<typeof setInterval> | undefined

function stopCycle(): void {
  if (timer === undefined) return
  clearInterval(timer)
  timer = undefined
}

// Any change of loop restarts it on its first frame, so a dwarf that just
// picked up a task never starts mid-swing — and one that breaks its silence
// picks the pick back up from the top of the swing rather than mid-stroke.
// A loop of fewer than two frames (the silence pose, #47) starts no timer at
// all, which is why standing still costs less than working.
watch(
  animation,
  (next) => {
    stopCycle()
    frameIndex.value = 0
    if (next.frames.length < 2) return
    timer = setInterval(() => {
      frameIndex.value = (frameIndex.value + 1) % next.frames.length
    }, next.frameMs)
  },
  { immediate: true }
)
onBeforeUnmount(stopCycle)

const frame = computed(() => {
  // A neutral stand covers the pause between the click and the terminal focus.
  if (props.activating === true) return NEUTRAL_DWARF_FRAME
  return animation.value.frames[frameIndex.value] ?? NEUTRAL_DWARF_FRAME
})
const frameSrc = computed(() => DWARF_FRAME_SRC[frame.value])

const isForeman = computed(() => props.dwarf.role === 'foreman')
const rootClasses = computed(() => [
  statusAnimationClass(props.dwarf.status),
  {
    'is-foreman': isForeman.value,
    'is-activating': props.activating,
    /*
     * The scene knows which rock this dwarf is facing; on its own, the sprite
     * falls back to the old rule that only a leaving dwarf is mirrored.
     *
     * Keyed off `anchored` rather than off `facesLeft` being undefined,
     * because Vue casts an absent boolean prop to `false` — so `facesLeft`
     * alone cannot tell "the scene says face right" from "no scene here".
     */
    'is-flipped':
      props.anchored === true ? props.facesLeft === true : isSpriteFlipped(props.dwarf.status),
    'is-anchored': props.anchored === true
  }
])
// The walk-out lasts exactly as long as the runtime keeps a leaving dwarf.
const exitStyle = computed(() => ({
  '--exit-ms': `${LEAVING_EXIT_MS}ms`,
  '--depth-scale': String(props.depthScale ?? 1)
}))

/**
 * Sparks off the rock. The counter is what the burst is keyed on, so every hit
 * mounts a fresh element and replays the animation instead of the CSS running
 * once and never again. Only a dwarf actually stood at the vein throws them —
 * not one still walking there, and not one resting.
 */
const SPARKS_PER_HIT = 5
const impactCount = ref(0)
watch(
  () => frame.value,
  (pose) => {
    if (props.dwarf.status !== 'working') return
    if (props.walking === true) return
    if (isPickImpact(pose)) impactCount.value++
  }
)
const ariaLabel = computed(
  () =>
    `Actions for ${props.dwarf.name} (${props.dwarf.role}, ${props.dwarf.provider}) — ${props.dwarf.status}`
)

/**
 * The verdict markers. The wording lives in lib/deliveryVerdict.ts because the
 * distinction it carries is load-bearing (issue #21): a ✓ says only that the
 * message was handed to the session, a ✓✓ says the session was seen acting on
 * it. The kick marker sits on the opposite corner so both can show at once.
 */
const sendMarker = computed(() => sendMarkerFor(props.sendState))
const kickMarker = computed(() => kickMarkerFor(props.kickState))
</script>

<template>
  <div class="dwarf-sprite" :class="rootClasses" :style="exitStyle">
    <SpeechBubble
      v-if="bubbleText"
      class="bubble-holder"
      :style="bubbleLiftStyle"
      :text="bubbleText"
      :expand-label="bubbleLabel"
      :expanded="bubbleExpanded"
      @expand="toggleBubble"
    />
    <!-- Click-through protection: a click inside the panel (scrolling, text
         selection) must not count as the outside click that closes it. -->
    <div
      v-if="bubbleExpanded"
      ref="expandedRef"
      class="bubble-expanded"
      role="note"
      :aria-label="`Full message from ${dwarf.name}`"
      :style="expandedStyle"
      @click.stop
    >
      {{ dwarf.lastMessage }}
    </div>
    <button
      ref="hitRef"
      class="dwarf-hit"
      type="button"
      :aria-label="ariaLabel"
      :aria-expanded="barOpen"
      @click.stop="toggleBar"
      @mouseenter="showTooltip"
      @mouseleave="hideTooltip"
      @focus="showTooltip"
      @blur="hideTooltip"
    >
      <img class="dwarf-frame" :src="frameSrc" alt="" aria-hidden="true" draggable="false" />
      <!-- Debris off the rock face, one burst per pick hit (see impactCount). -->
      <span v-if="impactCount > 0" :key="impactCount" class="spark-burst" aria-hidden="true">
        <i v-for="n in SPARKS_PER_HIT" :key="n" class="spark" :style="{ '--spark': n }"></i>
      </span>
      <span
        class="provider-dot"
        :class="`provider-${dwarf.provider}`"
        :title="dwarf.provider"
        aria-hidden="true"
      ></span>
      <span v-if="dwarf.status === 'waiting'" class="zzz" aria-hidden="true">z z z</span>
      <span
        v-if="sendMarker"
        class="send-result"
        :class="sendMarker.cls"
        :title="sendMarker.title"
        >{{ sendMarker.glyph }}</span
      >
      <span
        v-if="kickMarker"
        class="kick-result"
        :class="kickMarker.cls"
        :title="kickMarker.title"
        >{{ kickMarker.glyph }}</span
      >
    </button>
    <span class="dwarf-name">{{ dwarf.name }}</span>
    <DwarfTooltip
      ref="tooltipRef"
      class="tooltip-holder"
      :class="{ 'is-visible': tooltipVisible }"
      :style="tooltipStyle"
      :dwarf="dwarf"
    />
    <DwarfActionBar
      v-if="barOpen"
      ref="barRef"
      class="bar-holder"
      :style="barStyle"
      :dwarf="dwarf"
      :send-state="sendState"
      :kick-state="kickState"
      @open-console="openConsole"
      @send="sendText"
      @kick="kick"
      @close="closeBar"
    />
  </div>
</template>

<style scoped>
/*
 * `--sprite-width` / `--sprite-height` are set by MineScene from the MEASURED
 * cave box (see lib/sceneSizing.ts), so the crew scales with the painting they
 * stand in rather than staying one size while the panel shrinks around them.
 * The fallbacks are the sizes the sprite was authored at, which is what a
 * sprite mounted outside any scene still draws at.
 */
.dwarf-sprite {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  width: var(--sprite-width, 96px);
}
.dwarf-hit {
  position: relative;
  display: block;
  padding: 0;
  border: 0;
  cursor: pointer;
  background: transparent;
  line-height: 0;
}
.dwarf-hit:focus-visible {
  outline: 2px solid #ffe29c;
  outline-offset: 3px;
  border-radius: 8px;
}
.dwarf-frame {
  display: block;
  width: auto;
  /*
   * All nine poses share one canvas, so a fixed height fixes the width too.
   *
   * Two scales compose here, and they answer different questions.
   * `--sprite-height` is how big the SCENE is drawn — MineScene derives it from
   * the measured cave box, so a dwarf is the right size next to the rock at
   * every panel shape (issue #44). `--depth-scale` is perspective WITHIN that
   * scene, shrinking a dwarf standing further back down the gallery.
   *
   * Both shrink the drawing rather than transforming the sprite: a transform
   * here would become the containing block for the `position: fixed` tooltip,
   * bar and expanded bubble below, and they must stay clamped to the viewport
   * (see computeTooltipPlacement). That constraint is why the panel size
   * arrives as a custom property feeding `height` and not as a `scale()`.
   */
  height: calc(var(--sprite-height, 100px) * var(--depth-scale, 1));
  filter: drop-shadow(0 4px 5px #000a);
  user-select: none;
}
.is-flipped .dwarf-frame {
  scale: -1 1;
}
.is-activating {
  opacity: 0.55;
}
.dwarf-name {
  /* Follows the sprite's own box so the label never outgrows the dwarf it names. */
  max-width: var(--sprite-width, 96px);
  margin-top: 2px;
  overflow: hidden;
  color: var(--ink-dim);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/*
 * The art is painted, not tinted: the provider gets its own small badge so the
 * palette of the drawing survives.
 */
.provider-dot {
  position: absolute;
  right: 10px;
  bottom: 4px;
  width: 9px;
  height: 9px;
  border: 1px solid #000000a6;
  border-radius: 50%;
  background: var(--provider-tint, #b9aa91);
  box-shadow: 0 0 6px var(--provider-tint, #b9aa91);
}
.provider-claude {
  --provider-tint: #d97757;
}
.provider-codex {
  --provider-tint: #cfd4d9;
}

/* waiting: Zzz drifting up off the resting pose */
.zzz {
  position: absolute;
  top: -6px;
  right: -2px;
  color: var(--ink-dim);
  font-size: 11px;
  font-style: italic;
  letter-spacing: 0.12em;
  line-height: 1;
  pointer-events: none;
  animation: zzz-float 3.2s ease-in-out infinite;
}

/* leaving: walks toward the exit and fades within the runtime grace window */
.is-leaving {
  animation: walk-out var(--exit-ms, 16000ms) linear forwards;
  pointer-events: none;
}
/*
 * Inside the scene the dwarf is already being walked to the painted exit by
 * MineScene, so the blind leftward slide would double the movement and drag it
 * through the rock wall. Only the fade survives, on the same timing.
 */
.is-anchored.is-leaving {
  animation: exit-fade var(--exit-ms, 16000ms) linear forwards;
}

/*
 * working: debris thrown off the rock on the down-stroke of the swing. Sized
 * and coloured off the tier so gold sparks gold, and thrown from the pick head
 * — up and forward of the dwarf, mirrored with it when it faces left.
 */
.spark-burst {
  position: absolute;
  top: 26%;
  left: 68%;
  width: 0;
  height: 0;
  pointer-events: none;
}
.is-flipped .spark-burst {
  left: 32%;
}
.spark {
  position: absolute;
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--tier-glow, #ffe29c);
  box-shadow: 0 0 4px var(--tier-accent, #ffb347);
  /* Fanned by index: each spark leaves on its own angle and its own beat. */
  animation: spark-fly 620ms ease-out forwards;
  animation-delay: calc(var(--spark, 1) * 18ms);
  rotate: calc(var(--spark, 1) * 38deg - 76deg);
}

@keyframes zzz-float {
  0% {
    opacity: 0;
    transform: translateY(4px);
  }
  30% {
    opacity: 0.9;
  }
  70% {
    opacity: 0;
    transform: translateY(-9px);
  }
  100% {
    opacity: 0;
  }
}
@keyframes walk-out {
  0% {
    opacity: 1;
    translate: 0 0;
  }
  85% {
    opacity: 1;
  }
  100% {
    opacity: 0;
    translate: -480px 0;
  }
}
/* The same grace window as walk-out, minus the slide the scene now owns. */
@keyframes exit-fade {
  0%,
  85% {
    opacity: 1;
  }
  100% {
    opacity: 0;
  }
}
@keyframes spark-fly {
  0% {
    opacity: 1;
    translate: 0 0;
  }
  100% {
    opacity: 0;
    translate: 14px -10px;
  }
}

/*
 * A viewer who asked for less movement still gets the whole scene — every
 * dwarf stands at its painted feature — but nothing twitches, sparks or
 * drifts to get there.
 */
@media (prefers-reduced-motion: reduce) {
  .spark-burst {
    display: none;
  }
  .zzz {
    animation: none;
    opacity: 0.9;
  }
  .is-leaving,
  .is-anchored.is-leaving {
    animation: none;
    opacity: 0.55;
  }
}

.bubble-holder {
  position: absolute;
  z-index: 20;
  /*
   * `--bubble-lift` (issue #43) is only ever set when this dwarf shares its
   * scene anchor with another (see bubbleLiftStyle above); the var() fallback
   * keeps every other bubble at exactly the spot it has always drawn at.
   */
  bottom: calc(100% + 2px + var(--bubble-lift, 0px));
  left: 46%;
}
/*
 * Fixed positioning (not relative to .dwarf-sprite): left/top come from
 * computeTooltipPlacement() in viewport coordinates, so the tooltip can be
 * clamped/flipped inside the panel instead of always centering under the
 * sprite and clipping off-screen near an edge.
 */
.tooltip-holder {
  position: fixed;
  z-index: 30;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.15s;
}
.tooltip-holder.is-visible {
  opacity: 1;
}
/* Same fixed/clamped placement as the tooltip, above every other sprite. */
.bar-holder {
  position: fixed;
  z-index: 40;
}
/*
 * The expanded bubble: fixed and clamped like the tooltip/bar (the cave
 * clips absolute children). Scrolls when an agent wrote an essay; pre-wrap
 * keeps the message's own line breaks — the truncated bubble flattens them,
 * the full view must not.
 */
.bubble-expanded {
  position: fixed;
  z-index: 40;
  overflow-y: auto;
  max-width: 280px;
  max-height: 190px;
  padding: 8px 11px;
  border: 1px solid var(--parchment-line);
  border-radius: 10px;
  color: var(--parchment-ink);
  background: var(--parchment);
  font-size: 11px;
  line-height: 1.4;
  text-align: left;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  box-shadow: 0 6px 18px #000a;
}

/* Delivery verdict for the last message, cleared by the store after a moment. */
.send-result {
  position: absolute;
  top: -4px;
  left: -4px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border: 1px solid #000000a6;
  border-radius: 50%;
  color: #14100b;
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
  pointer-events: none;
}
.send-result.is-delivered {
  background: #8fd07a;
}
/*
 * The confirmed reaction reads as a stronger version of the same green, and its
 * ✓✓ needs the extra room a single glyph does not.
 */
.send-result.is-reacted {
  width: auto;
  padding: 0 3px;
  border-radius: 8px;
  background: #4fa63a;
  letter-spacing: -1px;
}
.send-result.is-failed {
  background: #e08466;
}
.send-result.is-sending {
  color: var(--ink);
  background: #4b3c28;
}

/* Kick's own verdict marker: same styling, opposite corner so both can show at once. */
.kick-result {
  position: absolute;
  top: -4px;
  right: -4px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border: 1px solid #000000a6;
  border-radius: 50%;
  color: #14100b;
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
  pointer-events: none;
}
.kick-result.is-delivered {
  background: #8fd07a;
}
.kick-result.is-reacted {
  width: auto;
  padding: 0 3px;
  border-radius: 8px;
  background: #4fa63a;
  letter-spacing: -1px;
}
.kick-result.is-failed {
  background: #e08466;
}
.kick-result.is-sending {
  color: var(--ink);
  background: #4b3c28;
}
</style>
