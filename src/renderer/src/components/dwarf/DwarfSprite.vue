<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { preloadDwarfArt } from '../../lib/art'
import { observerLabel } from '../../lib/dwarf/observerLabel'
import { bubbleRowOffsetPx } from '../../lib/overlay/bubbleLayout'
import {
  kickMarker as kickMarkerFor,
  sendMarker as sendMarkerFor
} from '../../lib/delivery/deliveryVerdict'
import { LEAVING_EXIT_MS, statusAnimationClass } from '../../lib/presentation'
import { dwarfClips, isAwaitingAnswer, stillFrameOf } from '../../lib/sprite/dwarfSequence'
import {
  SPRITE_FRAME_SIZE,
  backgroundSizePercent,
  framePositionPercent,
  isGlowFrame,
  isImpactFrame,
  sequenceFrameAt,
  sequenceIsStill,
  type SpriteClip
} from '../../lib/sprite/spriteSheet'
import { prefersReducedMotion, watchReducedMotion } from '../../lib/scene/sceneMotion'
import { computeTooltipPlacement } from '../../lib/overlay/tooltip'
import type { Dwarf, DwarfKickState, DwarfSendState } from '../../types'
import DwarfStatusIcons from './DwarfStatusIcons.vue'
import DwarfTooltip from './DwarfTooltip.vue'

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
  /**
   * Whether this is the dwarf the message panel is open on (#159).
   *
   * Owned above rather than here. Selection used to BE this sprite's own
   * action bar being open, which worked while the surface hung off the
   * sprite; the design's panel is docked at the bottom of the screen, so
   * exactly one dwarf in the whole mine may be selected and no sprite can
   * know that about its neighbours. What did not change is what selection
   * looks like or what it does to the animation: nothing.
   */
  selected?: boolean
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
  /** This dwarf was clicked. What that opens is decided above (#159). */
  select: []
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
 * Clicking a dwarf selects it, and the message panel docked at the bottom of
 * the screen is what opens (#159). The sprite reports the click and nothing
 * else: only one dwarf in the mine may be selected, which is not a fact a
 * sprite can hold about itself.
 */
function select(): void {
  hideTooltip()
  // One popover at a time: opening the panel replaces an expanded bubble,
  // mirroring how it replaces the hover tooltip just above.
  collapseBubble()
  emit('select')
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
 * Whether anything at all floats over this dwarf (#153).
 *
 * The three glyphs answer three different questions — is it talking, has it
 * asked its user something, is it resting — so the row mounts when any of them
 * does, rather than only when there is a message the way the balloon did.
 */
const hasStatusIcon = computed(
  () =>
    Boolean(props.bubbleText) ||
    props.dwarf.pendingQuestion !== undefined ||
    props.dwarf.waitingReason === 'approval' ||
    props.dwarf.status === 'waiting'
)

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
 * Whether this viewer asked their operating system for less movement (issue
 * #71). Read the way every other site in the app reads it — the shared
 * prefersReducedMotion query, not a fifth mechanism — and then WATCHED, which
 * is the part MineScene does not need: the scene decides before its first paint
 * and never again, whereas a frame timer left running is exactly the thing the
 * viewer asked to stop, and they must not have to relaunch to stop it.
 */
const reducedMotion = ref(prefersReducedMotion())
const stopWatchingMotion = watchReducedMotion((reduced) => {
  reducedMotion.value = reduced
})
onBeforeUnmount(stopWatchingMotion)

/**
 * Whether a person has been asked something and has not answered (issue #60).
 *
 * The waiting reason is passed straight through, never re-derived here: only
 * the provider knows whether a human was actually asked, and a sprite that
 * guessed would be the fabricated status the issue forbids.
 */
const awaiting = computed(() => isAwaitingAnswer(props.dwarf.status, props.dwarf.waitingReason))

/**
 * Whether this dwarf is at the rock (issue #74). Unlike `awaiting`, this is a
 * direct read of the status — `working` has no other signal feeding it — but
 * it still has to be its own watched value: going from an ordinary `waiting`
 * straight to `working` (no human ever asked) changes nothing about
 * `awaiting` on either side of that transition, so `dwarfClips` would never
 * be re-run for it if the watch below only tracked `awaiting`.
 */
const working = computed(() => props.dwarf.status === 'working')

/**
 * The strips to play, and how far into them the drawing is.
 *
 * `elapsedMs` rather than a frame counter, because a sequence is more than one
 * strip: the elapsed figure is what lets a transition played once hand over to
 * the loop behind it without a second timer, and it makes the whole cadence a
 * pure function this component only has to advance (see lib/sprite).
 *
 * The watcher carries the PREVIOUS answer on each axis into `dwarfClips`,
 * which is what turns a state into a transition — a foreman lies down when
 * the question arrives and gets up when it is answered, a worker picks up its
 * pick when it starts and sets it down when it stops, rather than either
 * simply appearing that way. Vue hands `undefined` as the old value on the
 * immediate first run, which is exactly the "nothing to leave" case the
 * sequence wants.
 */
const clips = ref<readonly SpriteClip[]>([])
const elapsedMs = ref(0)
let timer: ReturnType<typeof setInterval> | undefined

function stopCycle(): void {
  if (timer === undefined) return
  clearInterval(timer)
  timer = undefined
}

// Any change of state restarts the sequence at its head, so a dwarf that just
// picked up a task never starts mid-gesture.
watch(
  [awaiting, working, () => props.dwarf.role] as const,
  ([nowAwaiting, nowWorking, role], previous) => {
    clips.value = dwarfClips(role, nowAwaiting, previous?.[0], nowWorking, previous?.[1])
    elapsedMs.value = 0
  },
  { immediate: true }
)

const position = computed(() =>
  // Reduced motion is answered by holding one frame and running no timer at
  // all, which is the same shape a one-frame loop already had (issue #71).
  reducedMotion.value ? stillFrameOf(clips.value) : sequenceFrameAt(clips.value, elapsedMs.value)
)
const sheet = computed(() => clips.value[position.value.clip]?.sheet)

// One interval per sprite, stepping at the CURRENT clip's own hold — so a
// transition drawn at a different tempo from the loop it hands over to needs
// no second mechanism. A sequence that can never change starts no timer.
watch(
  [clips, reducedMotion, () => sheet.value?.frameMs],
  () => {
    stopCycle()
    if (reducedMotion.value || sequenceIsStill(clips.value)) return
    const step = sheet.value?.frameMs
    if (step === undefined || step <= 0) return
    timer = setInterval(() => {
      elapsedMs.value += step
    }, step)
  },
  { immediate: true }
)
onBeforeUnmount(stopCycle)

/**
 * Which frame of the strip is showing, as the percentage the CSS slides by.
 *
 * ONLY the position lives on this element, and that is deliberate. Vue rewrites
 * every declaration in a bound style object on each patch, so anything sitting
 * beside this gets re-set ten times a second per dwarf. The strip's URL is the
 * thing that must not: Vite inlines a sheet under 4 KB as a base64 data URI, so
 * four of the five are several kilobytes of string, and a crowded valley (#42)
 * would be rewriting all of it continuously. It rides on the root instead,
 * where it changes only when the dwarf changes what it is doing, and inherits
 * down — which is what custom properties are for.
 *
 * Percentages rather than pixels so the arithmetic survives both scales the
 * drawing is under — the scene's own and the per-depth one — neither of which
 * lands on a whole multiple of a 36px frame.
 */
const frameStyle = computed(() => {
  const strip = sheet.value
  if (strip === undefined) return undefined
  return { '--sheet-position': `${framePositionPercent(position.value.frame, strip.frames)}% 0` }
})

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
    /*
     * THE SHEETS ARE PAINTED FACING LEFT (#156), so `is-flipped` means "facing
     * RIGHT" and a dwarf facing left is drawn exactly as painted.
     *
     * It was the other way round until the second acceptance run, on the
     * strength of a sentence #131 flagged as unconfirmed and nobody checked.
     * Every station's facing was authored, transcribed and read correctly, and
     * the whole mine still rendered in a mirror. The art is measured rather than
     * assumed now, in lib/sprite/sheetFacing.test.ts: the helmet lamp's beam
     * sits left of the dwarf on every waking sheet, and a lamp shines where its
     * wearer looks.
     *
     * Outside the scene there is nothing to face but the way the art is
     * painted — including a leaver, whose exit slide runs left too.
     */
    'is-flipped': props.anchored === true && props.facesLeft !== true,
    'is-anchored': props.anchored === true,
    /*
     * ARRIVED at the way out (#156). A departure disappears when it REACHES the
     * nearest spawn point, never on a clock: the fade used to start the moment
     * the status turned 'leaving' and run for a fixed window while the scene was
     * still walking the dwarf there, so anything further out than that window
     * faded mid-route — which the maintainer watched happen to a foreman. The
     * runtime's grace window still caps how long a departure may take; what it
     * does not do is decide when the fade begins.
     */
    'is-departed':
      props.anchored === true && props.dwarf.status === 'leaving' && props.walking !== true,
    /*
     * The design's red halo (#153). Which dwarf is selected is the panel's
     * business (#159), so it arrives as a prop rather than being read off a
     * popover this sprite owns — and nothing here touches the animation: the
     * source says outright that a selected dwarf keeps moving and working.
     */
    'is-selected': props.selected === true
  }
])
// The walk-out lasts exactly as long as the runtime keeps a leaving dwarf.
// `--frame-aspect` carries the authored frame box so the CSS never repeats it,
// and the strip rides here rather than on the frame so that the only thing
// rewritten ten times a second is the one short percentage (see frameStyle).
const exitStyle = computed(() => ({
  '--exit-ms': `${LEAVING_EXIT_MS}ms`,
  '--depth-scale': String(props.depthScale ?? 1),
  '--frame-aspect': `${SPRITE_FRAME_SIZE.width} / ${SPRITE_FRAME_SIZE.height}`,
  '--sheet-image': sheet.value === undefined ? 'none' : `url(${sheet.value.src})`,
  '--sheet-size':
    sheet.value === undefined ? '100% 100%' : `${backgroundSizePercent(sheet.value)}% 100%`
}))

/**
 * Sparks off the rock. The counter is what the burst is keyed on, so every hit
 * mounts a fresh element and replays the animation instead of the CSS running
 * once and never again. Only a dwarf actually stood at the vein throws them —
 * not one still walking there, and not one resting.
 *
 * Which frame IS a hit is the sheet's own claim rather than a pose name the
 * sprite recognises, so the swing #74 has yet to draw brings the sparks back by
 * declaring one. No sheet drawn so far declares any, and an idle loop that did
 * would throw debris off a dwarf standing still.
 */
const SPARKS_PER_HIT = 5
const impactCount = ref(0)
watch(
  () => position.value,
  (now) => {
    if (props.dwarf.status !== 'working') return
    if (props.walking === true) return
    const strip = clips.value[now.clip]?.sheet
    if (strip !== undefined && isImpactFrame(strip, now.frame)) impactCount.value++
  }
)

/**
 * The strike's own light (issue #74's last piece): a brief glow layered over
 * the art's own sparks, on exactly the frames the SHEET names as bright — the
 * same data-driven rule `isImpactFrame` follows above, and for the same
 * reason: a pose name cannot survive the art swap, a declared frame can.
 *
 * Same guards as `impactCount`'s watcher (working, not mid-walk), plus one of
 * its own: reduced motion never shows it, even where the held still frame
 * happens to be a declared glow frame — a pulsing light is exactly the
 * movement that preference asks to stop, not information it would strip.
 */
const strikeGlow = computed(() => {
  if (reducedMotion.value) return false
  if (props.dwarf.status !== 'working') return false
  if (props.walking === true) return false
  const strip = sheet.value
  return strip !== undefined && isGlowFrame(strip, position.value.frame)
})
const ariaLabel = computed(
  () =>
    `Select ${props.dwarf.name} (${props.dwarf.role}, ${observerLabel(props.dwarf.provider)}) — ${props.dwarf.status}`
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
    <!--
      The design's three status icons (#153), where the parchment balloon used
      to be. Mounted whenever any of them applies rather than only on a message,
      because the sleep and question glyphs are states of the dwarf and not of
      what it last said.
    -->
    <DwarfStatusIcons
      v-if="hasStatusIcon"
      class="bubble-holder"
      :style="bubbleLiftStyle"
      :role="dwarf.role"
      :talking="Boolean(bubbleText)"
      :asking="dwarf.pendingQuestion !== undefined"
      :awaiting-approval="dwarf.waitingReason === 'approval'"
      :resting="dwarf.status === 'waiting'"
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
      :aria-pressed="selected === true"
      @click.stop="select"
      @mouseenter="showTooltip"
      @mouseleave="hideTooltip"
      @focus="showTooltip"
      @blur="hideTooltip"
    >
      <span
        class="dwarf-frame"
        :class="{ 'is-strike-glow': strikeGlow }"
        :style="frameStyle"
        aria-hidden="true"
      ></span>
      <!-- Debris off the rock face, one burst per pick hit (see impactCount). -->
      <span v-if="impactCount > 0" :key="impactCount" class="spark-burst" aria-hidden="true">
        <i v-for="n in SPARKS_PER_HIT" :key="n" class="spark" :style="{ '--spark': n }"></i>
      </span>
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
  </div>
</template>

<style scoped>
/*
 * `--sprite-width` / `--sprite-height` are set by MineScene from the MEASURED
 * cave box (see lib/sceneSizing.ts), so the crew scales with the painting they
 * stand in rather than staying one size while the panel shrinks around them.
 * The fallbacks are the sizes the sprite was authored at, which is what a
 * sprite mounted outside any scene still draws at. The width is AUTHORED_SPRITE
 * rounded to a whole pixel: it follows the 36x38 frame now (94.74), and a
 * fraction in a fallback nobody can derive from the constant reads as drift.
 */
.dwarf-sprite {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  width: var(--sprite-width, 95px);
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
  /*
   * The strip is one PNG holding every frame side by side; the box shows one
   * of them. `--sheet-size` stretches the image to one box per frame and
   * `--sheet-position` slides it (see lib/sprite/spriteSheet.ts). Both arrive
   * as percentages so the arithmetic survives the two scales below, neither of
   * which lands on a whole multiple of a 36px frame.
   */
  aspect-ratio: var(--frame-aspect);
  background-image: var(--sheet-image);
  background-repeat: no-repeat;
  background-size: var(--sheet-size);
  background-position: var(--sheet-position);
  /*
   * The one declaration that keeps hand-drawn pixel art looking hand-drawn
   * (issue #90). The frame is 38px tall and is drawn at roughly 100, modulated
   * again per depth, so the scale factor is essentially never an integer —
   * without this the browser interpolates, every hard edge goes soft, and the
   * art gets the blame for a rendering decision.
   */
  image-rendering: pixelated;
  /*
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
/*
 * The strike's own light (issue #74's last piece), toggled by `strikeGlow`
 * on the sheet's own declared `glowFrames` — never a hardcoded frame number
 * here. A pseudo-element rather than a template node, so nothing is added to
 * the DOM per tick; `position: relative` on this one variant is a no-op for
 * layout (no offsets follow it), it only gives the glow a box to sit inside.
 * Placed on the pick-tip side of the frame — the same corner `.spark-burst`
 * throws from, and mirrored the same way — so the light and the art's own
 * sparks share one origin. Amber from the tier tokens every other glow in
 * the panel already uses (see MineMound.vue), never a colour invented here;
 * kept soft so the art's own sparks stay the protagonist.
 */
.dwarf-frame.is-strike-glow {
  position: relative;
}
.dwarf-frame.is-strike-glow::after {
  content: '';
  position: absolute;
  top: 18%;
  /* The pick side of the art AS PAINTED, which is the left of the frame (#156). */
  left: -2%;
  width: 44%;
  height: 44%;
  background: radial-gradient(circle, var(--tier-glow, #ffe29c) 0%, transparent 72%);
  pointer-events: none;
}
.is-flipped .dwarf-frame.is-strike-glow::after {
  left: 58%;
}
.is-activating {
  opacity: 0.55;
}
.dwarf-name {
  /* Follows the sprite's own box so the label never outgrows the dwarf it names. */
  max-width: var(--sprite-width, 95px);
  margin-top: 2px;
  overflow: hidden;
  color: var(--ink-dim);
  font-size: var(--text-meta);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/*
 * WHAT WENT FROM OVER THE SPRITE (#153).
 *
 * `.provider-dot` and its two tints painted a provider-coloured bead on every
 * dwarf. It was never in the design, it said nothing the tooltip does not — that
 * prints `<role> · <provider>` on hover and focus, and the sprite's accessible
 * name carries it too — and the maintainer ruled the sprite renders clean.
 *
 * `.zzz` and its `zzz-float` keyframes typed `z z z` over a resting dwarf. The
 * design has its own 15px sleep glyph, and it is drawn in DwarfStatusIcons with
 * the other two.
 *
 * ── The red halo on the selected dwarf ──────────────────────────────────────
 *
 * `screens/mine.md`: clicking a dwarf "marks the selected dwarf with a red halo"
 * and "does NOT pause it; it continues moving and working". So this is a ring
 * around the sprite and nothing else — no state the animation reads, no branch
 * anywhere near the frame timer. Drawn on the whole sprite rather than on the
 * hit box so the name under it is inside the ring too.
 *
 * The source does not name the red. `--danger-line` is the one red the app
 * already declares, and inventing a second would leave two.
 */
.is-selected .dwarf-frame {
  /*
   * #156's eleventh correction. #153 drew this as two stacked drop-shadows at
   * 3px and 7px, and the acceptance run called the outline too thick and too
   * loud. The maintainer's ruling is a thinner outline with the red moved ONTO
   * the dwarf, at about half strength.
   *
   * The tint is a filter on the frame because that is the only place one can
   * reach this art at all: the sprite is a background image scrolled a frame at
   * a time, so there is no element to paint over and no pixel to recolour.
   * `sepia()` takes its strength as an amount, which is what makes "about half"
   * expressible at all in a filter chain; the hue rotation carries its warm
   * brown round to the red the design asks for, and the saturation keeps it from
   * reading as rust. The base shadow is repeated because `filter` REPLACES —
   * dropping it would lift a selected dwarf off the rock the others stand on.
   *
   * Nothing here animates, which is the whole reason the reduced-motion note
   * below has nothing to switch off.
   */
  filter: drop-shadow(0 4px 5px #000a) drop-shadow(0 0 2px var(--danger-line)) sepia(0.5)
    hue-rotate(-30deg) saturate(1.6);
}
.is-selected .dwarf-name {
  color: var(--danger-line);
}
/*
 * A viewer who asked for less movement still gets the halo — it is the thing
 * that says which dwarf is selected, which is information rather than
 * decoration. What they do not get is it pulsing, which is why there is no
 * animation here to switch off.
 */

/* leaving: walks toward the exit and fades within the runtime grace window */
.is-leaving {
  animation: walk-out var(--exit-ms, 16000ms) linear forwards;
  pointer-events: none;
}
/*
 * Inside the scene the dwarf is already being walked to the painted exit by
 * MineScene, so the blind leftward slide would double the movement and drag it
 * through the rock wall. Only the fade survives — and it is keyed on having
 * ARRIVED rather than on having been told to leave (#156), so a dwarf still on
 * its way out is at full strength the whole way and goes at the exit itself.
 */
.is-anchored.is-departed {
  animation: exit-fade var(--exit-ms, 16000ms) linear forwards;
}

/*
 * working: debris thrown off the rock on the down-stroke of the swing. Sized
 * and coloured off the tier so gold sparks gold, and thrown from the pick head
 * — up and forward of the dwarf, mirrored with it when it faces right (#156).
 */
.spark-burst {
  position: absolute;
  top: 26%;
  /* Same side as the strike's own light: the pick side of the art as painted. */
  left: 32%;
  width: 0;
  height: 0;
  pointer-events: none;
}
.is-flipped .spark-burst {
  left: 68%;
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

/*
 * Both of these used to hold full opacity until 85% of a sixteen-second window
 * and fade over what was left, which is why a dwarf that had reached its exit
 * stood there (#153). They fade the whole way now, over a window short enough to
 * read as leaving rather than as lingering — see LEAVING_EXIT_MS. The slide
 * shortened with it: 480px in 1.2s would be a sprint.
 */
@keyframes walk-out {
  0% {
    opacity: 1;
    translate: 0 0;
  }
  100% {
    opacity: 0;
    translate: -60px 0;
  }
}
/* The same window as walk-out, minus the slide the scene now owns. */
@keyframes exit-fade {
  0% {
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
 *
 * The frame timer is answered in script rather than here (issue #71): CSS
 * cannot reach a setInterval, so the same preference is read through
 * prefersReducedMotion and collapses each loop to one held pose. This block is
 * only the part CSS owns.
 */
@media (prefers-reduced-motion: reduce) {
  .spark-burst {
    display: none;
  }
  /* Belt and suspenders alongside strikeGlow's own guard in script — see there. */
  .dwarf-frame.is-strike-glow::after {
    display: none;
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
  font-size: var(--text-meta);
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
  font-size: var(--text-meta);
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
  font-size: var(--text-meta);
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
