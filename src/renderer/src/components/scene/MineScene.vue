<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  ADD_ICON_SRC,
  CLOSE_ICON_SRC,
  HISTORY_ICON_SRC,
  INTERIOR_ART_SIZE,
  INTERIOR_SRC,
  maskImageValue
} from '../../lib/art'
import { createBubbleBoard } from '../../lib/overlay/bubbles'
import { assignScene } from '../../lib/scene/sceneAssignment'
import { clampToBox, projectToBox } from '../../lib/scene/sceneGeometry'
import { INTERIOR_ROUTE, routeBetween } from '../../lib/scene/interiorRoute'
import { depthOrder, nearestSpawn, sceneLayout, type ScenePoint } from '../../lib/scene/sceneLayout'
import { createWalkBoard, prefersReducedMotion, type WalkState } from '../../lib/scene/sceneMotion'
import {
  AUTHORED_INTERIOR_BOX,
  INTERIOR_FIT,
  MINE_ACTION_SIZE,
  spriteFootprintPx,
  spriteMarginPercent
} from '../../lib/scene/sceneSizing'
import type { Dwarf, DwarfKickState, DwarfSendState, Mine } from '../../types'
import DwarfSprite from '../dwarf/DwarfSprite.vue'
import VaultChip from '../vault/VaultChip.vue'

const props = defineProps<{
  mine: Mine
  /** Delivery state per dwarf id, so each sprite can show its own verdict. */
  sendStates?: Record<string, DwarfSendState>
  /** Kick state per dwarf id, so each sprite can show its own kick verdict. */
  kickStates?: Record<string, DwarfKickState>
  /**
   * The dwarf the message panel is open on, or null (#159). At most one in the
   * whole mine, which is exactly why it is passed down rather than held by a
   * sprite.
   */
  selectedId?: string | null
  /**
   * The dwarfs that were not on the panel's previous snapshot (#156).
   *
   * The walk board cannot work this out for itself: a mine nobody is working is
   * not on the board, so this scene is not mounted until the first agent starts
   * — and then it mounts with that agent already inside, which its own first
   * snapshot reads as crew that was there all along. See useMines.
   */
  arrived?: ReadonlySet<string>
}>()

const emit = defineEmits<{
  back: []
  /** A dwarf was clicked; the message panel above decides what that opens (#159). */
  select: [dwarf: Dwarf]
  /** The Add action was used; the shell above opens the Add Panel in its dock (#86). */
  add: []
  /** The History action was used; the shell above opens the Mine History panel (#192). */
  history: []
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

/**
 * Close, History and Add's shared size in CSS pixels (#197), bound onto the
 * interior the same way `interiorAspect` is. See `MINE_ACTION_SIZE` for where
 * the number comes from — nothing in the design source states it.
 */
const actionSize = `${MINE_ACTION_SIZE}px`

/**
 * The crew this scene draws: one entry per dwarf id (#165).
 *
 * The third acceptance run found more than one dwarf selected at once, which —
 * since a click opens the message panel — implied more than one panel.
 * Selection was already singular: App holds ONE id and DwarfSprite has no
 * selected state of its own. The leak was here. The scene lays out one sprite
 * per crew ENTRY, and nothing guaranteed the crew held one entry per dwarf; the
 * board is assembled from four sources plus a held session's own stamped crew,
 * and two of them naming one session puts it in the list twice. Both entries
 * then matched the one selected id and both wore the halo.
 *
 * The FIRST listing wins, which is the one the board saw first, so a dwarf does
 * not change appearance depending on which source spoke last. Everything the
 * scene does per dwarf reads this rather than the raw list — the layout, the
 * slots, the bubble board, the two delivery observers and the idle state — so
 * "one sprite per dwarf" is one rule in one place rather than five.
 */
const crew = computed(() => {
  const seen = new Set<string>()
  return props.mine.dwarfs.filter((dwarf) => {
    if (seen.has(dwarf.id)) return false
    seen.add(dwarf.id)
    return true
  })
})

const layout = computed(() => sceneLayout(props.mine.tier))
const placements = computed(() => assignScene(crew.value, layout.value))

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
    //
    // The third argument is #153's eleventh correction: a dwarf that turns up
    // after the mine was opened is an ARRIVAL, and it comes in at the nearest
    // entrance and walks its route to its station rather than materialising on
    // it. The crew that was already at work when the mine opened is placed —
    // the board draws that line itself, on the first sync.
    walkBoard.sync(
      targets,
      (from, to) => routeBetween(INTERIOR_ROUTE, from, to),
      (target) => nearestSpawn(layout.value, target),
      props.arrived
    )
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
  for (const dwarf of crew.value) {
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

/*
 * REMOVED for #162, stated here rather than passing unseen: this watch also
 * fed every poll's crew into the two delivery stores, which is what promoted a
 * delivered Send or Kick to 'reacted' (issue #21).
 *
 * Both stores live in the message-panel WINDOW now, because that is the window
 * that sends and kicks — and a watch for a reaction can only ever be resolved
 * where it was opened. Feeding them from here would fold snapshots into a copy
 * of the stores that nobody had opened a watch in. The verdicts arrive back on
 * this side as props (see `sendStates`/`kickStates`), and the promotion is
 * pinned in MessagePanelWindow.test.ts's 'publishing the delivery verdicts'.
 */
watch(crew, (dwarfs) => board.sync(dwarfs), { immediate: true })
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
      :style="{ '--interior-aspect': interiorAspect, '--action-size': actionSize }"
      :data-fit="INTERIOR_FIT"
    >
      <img class="interior-art" :src="interiorSrc" alt="" aria-hidden="true" draggable="false" />

      <!-- idle mine: nobody on the corridors -->
      <div v-if="crew.length === 0" class="mine-idle">
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
            :send-state="sendStates?.[slot.dwarf.id]"
            :kick-state="kickStates?.[slot.dwarf.id]"
            :selected="selectedId === slot.dwarf.id"
            anchored
            :walking="slot.walking"
            :faces-left="slot.facesLeft"
            @select="emit('select', slot.dwarf)"
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
        variant="strip"
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
        The design's History action (#192), directly below Close: it opens the
        read-only mine-wide history while the mine stays visible. Emits and
        decides nothing, for the reason Add does — App owns the dock the panel
        opens in. Drawn at Close's size, because the two are a stacked pair.
      -->
      <button
        class="mine-history"
        type="button"
        aria-label="Mine history"
        title="Mine history"
        @click="emit('history')"
      >
        <span
          class="action-glyph"
          :style="{ '--action-icon': maskImageValue(HISTORY_ICON_SRC) }"
          aria-hidden="true"
        ></span>
      </button>

      <!--
        The design's Add action, lower-right, which opens the in-mine Add Panel
        (components.md, "Mine Add action"). It emits and decides nothing: the
        panel docks at the bottom of the SHELL, beside this column rather than
        inside it, so App owns whether it is open exactly as it owns whether the
        MessagePanel is — the two share one dock.
      -->
      <button
        class="add-agent"
        type="button"
        aria-label="Launch an agent in this mine"
        title="Launch an agent in this mine"
        @click="emit('add')"
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
/*
 * The materials strip has no rule here at all any more (#153). It used to be
 * placed from out here and lost the specificity race against
 * `.vault-chip.is-inline { position: static }` inside the component — two
 * classes to one — so the strip fell into normal flow and floated at the
 * interior's TOP instead of sitting along its bottom edge. The chip's `strip`
 * variant places itself now, which is the only arrangement that cannot be lost
 * to a selector somebody else writes.
 */
/*
 * The three round actions the design floats on the interior: Close at the top
 * right, History directly below it (#192), Add at the lower right. All are
 * drawn through a CSS mask from the designer's own SVG, so the committed file
 * keeps its bytes and the colour comes from the tokens.
 */
.close-mine,
.mine-history,
.add-agent {
  position: absolute;
  z-index: 7;
  display: flex;
  align-items: center;
  justify-content: center;
  /*
    One size for all three (#197): the design source marks icon sizes
    Unspecified, and `MINE_ACTION_SIZE` (lib/scene/sceneSizing.ts) is the
    measured answer — Close's "X" and Add's "+" are the same 18px circle in
    the verified Canva export, so Add now matches Close and History rather
    than standing apart at 28px.
  */
  width: var(--action-size);
  height: var(--action-size);
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: #12100dd9;
  cursor: pointer;
}
.close-mine {
  top: 8px;
  right: 8px;
}
/* Close's size and column, one gap below it — the design draws them as a stacked pair. */
.mine-history {
  top: calc(8px + var(--action-size) + var(--space-nav-gap));
  right: 8px;
}
.add-agent {
  right: 8px;
  bottom: 26px;
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
.mine-history:hover,
.add-agent:not(:disabled):hover {
  background: var(--color-accent);
}
.close-mine:focus-visible,
.mine-history:focus-visible,
.add-agent:focus-visible {
  outline: 2px solid var(--color-cream);
  outline-offset: 2px;
}
</style>
