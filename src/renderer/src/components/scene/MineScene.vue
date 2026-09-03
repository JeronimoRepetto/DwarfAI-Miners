<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useDwarfKicking } from '../../composables/useDwarfKicking'
import { useDwarfMessaging } from '../../composables/useDwarfMessaging'
import {
  ADD_ICON_SRC,
  CLOSE_ICON_SRC,
  INTERIOR_ART_SIZE,
  INTERIOR_SRC,
  maskImageValue
} from '../../lib/art'
import { createBubbleBoard } from '../../lib/overlay/bubbles'
import { assignScene } from '../../lib/scene/sceneAssignment'
import { clampToBox, projectToBox } from '../../lib/scene/sceneGeometry'
import { INTERIOR_ROUTE, routeBetween } from '../../lib/scene/interiorRoute'
import { depthOrder, sceneLayout, type ScenePoint } from '../../lib/scene/sceneLayout'
import { createWalkBoard, prefersReducedMotion, type WalkState } from '../../lib/scene/sceneMotion'
import {
  AUTHORED_INTERIOR_BOX,
  INTERIOR_FIT,
  spriteFootprintPx,
  spriteMarginPercent
} from '../../lib/scene/sceneSizing'
import type { Dwarf, DwarfAnswerState, DwarfKickState, DwarfSendState, Mine } from '../../types'
import DwarfSprite from '../dwarf/DwarfSprite.vue'
import VaultChip from '../vault/VaultChip.vue'

const props = defineProps<{
  mine: Mine
  activatingId?: string | null
  /** Delivery state per dwarf id, so each sprite can show its own verdict. */
  sendStates?: Record<string, DwarfSendState>
  /** Kick state per dwarf id, so each sprite can show its own kick verdict. */
  kickStates?: Record<string, DwarfKickState>
  /** Answer state per dwarf id, so each sprite can show its own question verdict. */
  answerStates?: Record<string, DwarfAnswerState>
}>()

const emit = defineEmits<{
  back: []
  activate: [dwarf: Dwarf]
  'send-text': [dwarf: Dwarf, payload: { text: string; pressEnter: boolean }]
  kick: [dwarf: Dwarf]
  /** One of the agent's own option labels, answering that dwarf's outstanding ask (#125). */
  'answer-question': [dwarf: Dwarf, label: string]
}>()

/*
 * ── The mine interior, to the design (issue #137) ──────────────────────────
 *
 * A 245px column holding one of five production paintings, with the crew
 * standing on the workstations the design's own spatial map marks and walking
 * the corridors it draws between them. What replaced the concept cave is not
 * just the artwork: the anchors are extracted rather than authored, the crop is
 * `contain` rather than a bottom-pinned `cover`, movement follows a route graph
 * rather than a straight line, and the sprite scale comes from the design's own
 * "36px frames at 1x in a 245px interior" rather than from a measurement of the
 * old panel.
 *
 * The parts live in lib/ because none of them are Vue's business:
 *   interiorMap      every workstation and corridor, in percent of the painting
 *   interiorRoute    the line a dwarf walks between two of them
 *   sceneLayout      which stations a dwarf may occupy, and which way it faces
 *   sceneAssignment  which dwarf gets which spot, deterministically
 *   sceneGeometry    where that spot lands once the painting is fitted
 *   sceneSizing      how big a dwarf is drawn in this column
 *   sceneMotion      how long each leg takes and who is mid-walk
 *
 * This component only measures the box and mirrors the results into style.
 */

const interiorSrc = computed(() => INTERIOR_SRC[props.mine.tier])

/*
 * The design's frame, used until a real measurement lands — and in tests, where
 * jsdom lays nothing out and every rect is 0x0. Without it the first paint would
 * project every workstation through a degenerate box and stack the whole crew
 * in one corner.
 */
const interiorRef = ref<HTMLElement | null>(null)
const boxSize = ref({ ...AUTHORED_INTERIOR_BOX })
let boxObserver: ResizeObserver | undefined

onMounted(() => {
  const element = interiorRef.value
  if (!element) return
  const measure = (): void => {
    const rect = element.getBoundingClientRect()
    // A zero rect means "not laid out yet", never "the mine is empty": keeping
    // the last good size is what stops a hidden panel collapsing the scene.
    if (rect.width > 0 && rect.height > 0) {
      boxSize.value = { width: rect.width, height: rect.height }
    }
  }
  measure()
  // Both of the column's dimensions come from the display now (#153): its
  // height is the shell's, and its width is derived from that height at the
  // painting's own aspect. So every projected point moves whenever the shell is
  // re-docked or lands on another screen, and there is no authored size to fall
  // back on beyond the first frame.
  if (typeof ResizeObserver === 'function') {
    boxObserver = new ResizeObserver(measure)
    boxObserver.observe(element)
  }
})
onBeforeUnmount(() => boxObserver?.disconnect())

/*
 * The one measurement answers two questions. It says WHERE a workstation lands
 * once the painting is fitted into the column, and HOW BIG a dwarf standing on
 * it is drawn — he is a figure in the painting, so he scales with it. The maths
 * is in lib/sceneSizing.ts; this hands the result to CSS as custom properties
 * the sprites inherit.
 */
const spriteFootprint = computed(() => spriteFootprintPx(boxSize.value, INTERIOR_ART_SIZE))
const spriteMargin = computed(() => spriteMarginPercent(boxSize.value, INTERIOR_ART_SIZE))

/** The painting's own shape, so the column's frame and the projection agree. */
const interiorAspect = `${INTERIOR_ART_SIZE.width} / ${INTERIOR_ART_SIZE.height}`

const layout = computed(() => sceneLayout(props.mine.tier))
const placements = computed(() => assignScene(props.mine.dwarfs, layout.value))

/**
 * Reduced motion is answered by placing everyone statically rather than by
 * cutting the scene down: the point is that dwarfs inhabit the mine, and that is
 * content, not decoration. What goes away is the movement — no walk along the
 * route, no walk cycle, no sparks (see the reduced-motion block in DwarfSprite).
 */
// Read during setup rather than on mount: deciding after the first paint would
// let a single animated frame through for exactly the viewer who asked for none.
const reducedMotion = ref(prefersReducedMotion())

const walkState = ref<ReadonlyMap<string, WalkState>>(new Map())
const walkBoard = createWalkBoard((state) => {
  walkState.value = state
})

watch(
  placements,
  (next) => {
    if (reducedMotion.value) return
    const targets = new Map<string, ScenePoint>()
    for (const [id, placement] of next) targets.set(id, placement.point)
    // The board asks for a route only when a target has actually moved, so the
    // two-second poll does not re-plan the whole crew's journeys every tick.
    walkBoard.sync(targets, (from, to) => routeBetween(INTERIOR_ROUTE, from, to))
  },
  { immediate: true }
)

interface SceneSlot {
  dwarf: Dwarf
  left: number
  bottom: number
  zIndex: number
  facesLeft: boolean
  walking: boolean
  walkMs: number
  /** This dwarf's index among sharers of its station — see lib/bubbleLayout.ts (#43). */
  shareIndex: number
}

/** Every dwarf, resolved to the box coordinates and depth it should be drawn at. */
const slots = computed<SceneSlot[]>(() => {
  const box = boxSize.value
  const result: SceneSlot[] = []
  for (const dwarf of props.mine.dwarfs) {
    const placement = placements.value.get(dwarf.id)
    if (!placement) continue
    const walk = reducedMotion.value ? undefined : walkState.value.get(dwarf.id)
    // Mid-walk the dwarf is at the end of its current LEG, not at its station:
    // the sprite animates one leg at a time and the board owns which one.
    const point = walk?.point ?? placement.point
    const projected = clampToBox(
      projectToBox(point, box, INTERIOR_ART_SIZE, INTERIOR_FIT),
      spriteMargin.value.x,
      spriteMargin.value.y
    )
    result.push({
      dwarf,
      left: projected.x,
      // Positioned from the bottom so the dwarf's feet sit on the workstation.
      bottom: 100 - projected.y,
      zIndex: depthOrder(point.y),
      facesLeft: walk?.walking === true ? walk.facesLeft : placement.facesLeft,
      walking: walk?.walking === true,
      walkMs: walk?.legMs ?? 0,
      shareIndex: placement.shareIndex
    })
  }
  /*
   * Painted high to low. `zIndex` already stacks them correctly, but matching
   * DOM order to depth means the scene still reads right if anything ever
   * flattens the z-indexes — and it makes the rendered order say out loud what
   * the depth sorting is doing.
   *
   * Ties break on id, not on arrival order: two dwarfs on the same gallery are
   * common, and leaving their order to however the poll happened to list them
   * would reshuffle the DOM on every refresh.
   */
  return result.sort((a, b) => b.bottom - a.bottom || a.dwarf.id.localeCompare(b.dwarf.id))
})

const bubbles = ref<ReadonlyMap<string, string>>(new Map())
const board = createBubbleBoard((visible) => {
  bubbles.value = visible
})

/**
 * Every poll replaces this list, and it already carries each dwarf's status and
 * last message — which is exactly what tells a delivered Send or Kick whether
 * the session actually reacted (issue #21). Feeding the two delivery stores
 * from here keeps that second verdict phase free of any new IPC.
 */
const { observe: observeSends } = useDwarfMessaging()
const { observe: observeKicks } = useDwarfKicking()

watch(
  () => props.mine.dwarfs,
  (dwarfs) => {
    board.sync(dwarfs)
    observeSends(dwarfs)
    observeKicks(dwarfs)
  },
  { immediate: true }
)
onBeforeUnmount(() => {
  board.dispose()
  walkBoard.dispose()
})
</script>

<template>
  <section class="mine-scene" :data-tier="mine.tier" aria-labelledby="mine-title">
    <!--
      The design gives the mine column no header: the painting is the screen,
      and the only chrome on it is the two round actions. The name still has to
      exist for anything that reads the panel rather than looking at it, so it
      is the section's accessible name and nothing more.
    -->
    <h1 id="mine-title" class="scene-name">{{ mine.name }}</h1>

    <div
      ref="interiorRef"
      class="interior"
      :style="{ '--interior-aspect': interiorAspect }"
      :data-fit="INTERIOR_FIT"
    >
      <img class="interior-art" :src="interiorSrc" alt="" aria-hidden="true" draggable="false" />

      <!-- idle mine: nobody on the corridors -->
      <div v-if="mine.dwarfs.length === 0" class="mine-idle">
        <p>Nobody is working this mine yet.</p>
      </div>

      <!--
        The crew, each on the workstation its status sends it to, and each drawn
        at the size this column calls for. The two sizing properties are set once
        on the floor and inherited by every sprite below it — one measurement,
        one place it is published.
      -->
      <div
        v-else
        class="crew-floor"
        :class="{ 'is-still': reducedMotion }"
        :style="{
          '--sprite-width': `${spriteFootprint.width}px`,
          '--sprite-height': `${spriteFootprint.height}px`
        }"
      >
        <div
          v-for="slot in slots"
          :key="slot.dwarf.id"
          class="scene-slot"
          :style="{
            left: `${slot.left}%`,
            bottom: `${slot.bottom}%`,
            zIndex: slot.zIndex,
            '--walk-ms': `${slot.walkMs}ms`
          }"
        >
          <DwarfSprite
            :dwarf="slot.dwarf"
            :bubble-text="bubbles.get(slot.dwarf.id)"
            :bubble-row="slot.shareIndex"
            :activating="activatingId === slot.dwarf.id"
            :send-state="sendStates?.[slot.dwarf.id]"
            :kick-state="kickStates?.[slot.dwarf.id]"
            :answer-state="answerStates?.[slot.dwarf.id]"
            anchored
            :walking="slot.walking"
            :faces-left="slot.facesLeft"
            @activate="emit('activate', slot.dwarf)"
            @send-text="emit('send-text', slot.dwarf, $event)"
            @kick="emit('kick', slot.dwarf)"
            @answer="emit('answer-question', slot.dwarf, $event)"
            @bubble-hold="board.hold(slot.dwarf.id)"
            @bubble-release="board.release(slot.dwarf.id)"
          />
        </div>
      </div>

      <!--
        This mine's own vault, along the bottom edge of the interior exactly
        where the design's export draws it. One entry per material and never a
        merged figure: materials do not convert into one another (#22).
      -->
      <VaultChip
        class="interior-vault"
        variant="inline"
        :tokens-observed="mine.tokensObserved"
        :materials="mine.materials"
      />

      <!-- The design's round close, at the interior's top-right corner. It
           closes the MINE, never the window — the panel's own way out is the
           rail. -->
      <button class="close-mine" type="button" aria-label="Close mine" @click="emit('back')">
        <span
          class="action-glyph"
          :style="{ '--action-icon': maskImageValue(CLOSE_ICON_SRC) }"
          aria-hidden="true"
        ></span>
      </button>

      <!--
        The design's Add action, lower-right, which opens the in-mine Add Panel
        (components.md, "Mine Add action"). That panel is #86 and does not exist
        yet, so the control is rendered where the design puts it and DISABLED,
        with a title that says why. Deliberately not a live button that emits
        into nothing: a control that answers a click with silence is a worse lie
        than one that says it is not built.
      -->
      <button
        class="add-agent"
        type="button"
        disabled
        aria-label="Launch an agent in this mine"
        title="Launching an agent from inside the mine is not built yet"
      >
        <span
          class="action-glyph"
          :style="{ '--action-icon': maskImageValue(ADD_ICON_SRC) }"
          aria-hidden="true"
        ></span>
      </button>
    </div>
  </section>
</template>

<style scoped>
/*
 * The column is the height of the display and the painting is a fixed shape, so
 * the interior is centred in whatever is left rather than stretched to fill it.
 */
.mine-scene {
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-height: 0;
  height: 100%;
}
/* The mine's name: the section's accessible name, and nothing on screen. */
.scene-name {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
/*
 * The painting's own aspect ratio, bound from INTERIOR_ART_SIZE so the frame
 * and `sceneGeometry`'s projection cannot disagree about the shape. `contain`
 * still does the fitting: `aspect-ratio` is what keeps the frame hugging the
 * art rather than leaving a border round a letterboxed image, and the maths
 * stays correct if a future layout ever gives the box another shape.
 */
.interior {
  position: relative;
  flex: none;
  width: 100%;
  max-height: 100%;
  aspect-ratio: var(--interior-aspect);
  margin: auto;
  overflow: hidden;
  border-radius: var(--radius-default);
  background: var(--color-panel-deep);
}
.interior-art {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  object-position: 50% 50%;
  user-select: none;
}
.mine-idle {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 16px;
  color: var(--color-cream);
  font-size: var(--text-meta);
  text-align: center;
  text-shadow: 0 1px 4px #000;
}
.mine-idle p {
  margin: 0;
}
/*
 * No layout of its own: the crew is positioned individually against the
 * painting, so this is just the plane they live on.
 */
.crew-floor {
  position: absolute;
  inset: 0;
}
/*
 * One dwarf, standing on its workstation.
 *
 * `left`/`bottom` are animated rather than a transform on purpose. A transform
 * on this element would make it the containing block for the `position: fixed`
 * tooltip, action bar and expanded bubble inside DwarfSprite, and those are
 * placed in viewport coordinates by computeTooltipPlacement — they would all
 * land in the wrong place. At a handful of sprites in a small column the cost of
 * animating offsets instead is not measurable.
 *
 * `--walk-ms` is the current LEG's duration from sceneMotion, not the whole
 * journey's: the board advances the target corner by corner, and each corner
 * gets its own share of one steady pace.
 *
 * `margin-left` centres the sprite on its station and so has to follow the
 * sprite's own width. The negative `margin-bottom` discounts the name label so
 * the *feet* land on the spot, and stays a constant because the label is 10px
 * type that does not scale with the painting.
 */
.scene-slot {
  position: absolute;
  width: var(--sprite-width, 36px);
  margin-bottom: -14px;
  margin-left: calc(var(--sprite-width, 36px) / -2);
  transition:
    left var(--walk-ms, 0ms) linear,
    bottom var(--walk-ms, 0ms) linear;
}
/* Reduced motion: everyone is still placed in the mine, they just cut there. */
.crew-floor.is-still .scene-slot {
  transition: none;
}
@media (prefers-reduced-motion: reduce) {
  .scene-slot {
    transition: none;
  }
}
/* The materials strip along the interior's bottom edge, as the export draws it. */
.interior-vault {
  position: absolute;
  z-index: 6;
  right: 8px;
  bottom: 6px;
  left: 8px;
  justify-content: center;
  padding: 2px 6px;
  border: 0;
  border-radius: 999px;
  background: #0a0806cc;
}
/*
 * The two round actions the design floats on the interior: Close at the top
 * right, Add at the lower right. Both are drawn through a CSS mask from the
 * designer's own SVG, so the committed file keeps its bytes and the colour
 * comes from the tokens.
 */
.close-mine,
.add-agent {
  position: absolute;
  z-index: 7;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: #12100dd9;
  cursor: pointer;
}
.close-mine {
  top: 8px;
  right: 8px;
  width: 18px;
  height: 18px;
}
.add-agent {
  right: 8px;
  bottom: 26px;
  width: 28px;
  height: 28px;
  background: #12100d;
}
.add-agent:disabled {
  cursor: not-allowed;
}
.action-glyph {
  display: block;
  width: 60%;
  height: 60%;
  background: var(--color-cream);
  mask: var(--action-icon) center / contain no-repeat;
}
.close-mine:hover,
.add-agent:not(:disabled):hover {
  background: var(--color-accent);
}
.close-mine:focus-visible,
.add-agent:focus-visible {
  outline: 2px solid var(--color-cream);
  outline-offset: 2px;
}
</style>
