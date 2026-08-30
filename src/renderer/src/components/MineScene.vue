<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useDwarfKicking } from '../composables/useDwarfKicking'
import { useDwarfMessaging } from '../composables/useDwarfMessaging'
import { INTERIOR_ART_SIZE, INTERIOR_SRC } from '../lib/art'
import { createBubbleBoard } from '../lib/bubbles'
import { tierLabel } from '../lib/presentation'
import { assignScene } from '../lib/sceneAssignment'
import { clampToBox, projectToBox } from '../lib/sceneGeometry'
import {
  anchorPool,
  depthOrder,
  depthScale,
  sceneLayout,
  type ScenePoint
} from '../lib/sceneLayout'
import {
  createWalkBoard,
  prefersReducedMotion,
  walkDurationMs,
  walkFacesLeft
} from '../lib/sceneMotion'
import { vaultRows } from '../lib/vault'
import type { Dwarf, DwarfKickState, DwarfSendState, Mine } from '../types'
import DwarfSprite from './DwarfSprite.vue'
import NuggetPile from './NuggetPile.vue'
import VaultChip from './VaultChip.vue'

const props = defineProps<{
  mine: Mine
  activatingId?: string | null
  /** Delivery state per dwarf id, so each sprite can show its own verdict. */
  sendStates?: Record<string, DwarfSendState>
  /** Kick state per dwarf id, so each sprite can show its own kick verdict. */
  kickStates?: Record<string, DwarfKickState>
}>()

const emit = defineEmits<{
  back: []
  activate: [dwarf: Dwarf]
  'send-text': [dwarf: Dwarf, payload: { text: string; pressEnter: boolean }]
  kick: [dwarf: Dwarf]
}>()

const interiorSrc = computed(() => INTERIOR_SRC[props.mine.tier])

/*
 * ── The cave as a place, not a backdrop (issue #19) ────────────────────────
 *
 * The crew used to be a flex row pinned to the bottom of the panel: dwarfs
 * standing on an invisible line in front of a painting that neither knew nor
 * cared they were there. Now every dwarf is placed on an authored feature of
 * the painting itself — a vein, the rest boulders, the lit passage — and walks
 * between them as its status changes.
 *
 * The parts live in lib/ because none of them are Vue's business:
 *   sceneLayout      what is painted where, and where the floor is
 *   sceneAssignment  which dwarf gets which spot, deterministically
 *   sceneGeometry    where that spot lands once the panel is cropped
 *   sceneMotion      how long the walk takes and who is mid-walk
 *
 * This component only measures the box and mirrors the results into style.
 */

/**
 * The cave box at the default 460x600 panel. Used until a real measurement
 * lands — and in tests, where jsdom lays nothing out and every rect is 0x0.
 * Without it the first paint would project every anchor through a degenerate
 * box and stack the whole crew in one corner.
 */
const DEFAULT_CAVE_BOX = { width: 428, height: 512 }

/** Half the drawn width and height of a sprite, in box percent, so clamping keeps it on screen. */
const SPRITE_MARGIN_X = 11
const SPRITE_MARGIN_Y = 4

const caveRef = ref<HTMLElement | null>(null)
const boxSize = ref({ ...DEFAULT_CAVE_BOX })
let boxObserver: ResizeObserver | undefined

onMounted(() => {
  const element = caveRef.value
  if (!element) return
  const measure = (): void => {
    const rect = element.getBoundingClientRect()
    // A zero rect means "not laid out yet", never "the cave is empty": keeping
    // the last good size is what stops a hidden panel collapsing the scene.
    if (rect.width > 0 && rect.height > 0) {
      boxSize.value = { width: rect.width, height: rect.height }
    }
  }
  measure()
  // The panel is user-resizable, and the crop — and therefore every anchor's
  // position — changes with its shape, so the scene has to re-measure.
  if (typeof ResizeObserver === 'function') {
    boxObserver = new ResizeObserver(measure)
    boxObserver.observe(element)
  }
})
onBeforeUnmount(() => boxObserver?.disconnect())

const layout = computed(() => sceneLayout(props.mine.tier))
const placements = computed(() => assignScene(props.mine.dwarfs, layout.value))

/**
 * Reduced motion is answered by placing everyone statically rather than by
 * sending them back to the old bottom row: the point of the issue is that
 * dwarfs inhabit the cave, and that is content, not decoration. What goes away
 * is the movement — no walk transition, no walk cycle, no sparks (see the
 * reduced-motion block in DwarfSprite).
 */
// Read during setup rather than on mount: deciding after the first paint would
// let a single animated frame through for exactly the viewer who asked for none.
const reducedMotion = ref(prefersReducedMotion())

const walkingIds = ref<ReadonlySet<string>>(new Set())
const travelFacesLeft = ref<ReadonlyMap<string, boolean>>(new Map())
const walkMs = ref<ReadonlyMap<string, number>>(new Map())
const walkBoard = createWalkBoard((walking) => {
  walkingIds.value = walking
})

/** The spot each dwarf was last sent to, so a new target reads as a journey. */
const lastPoints = new Map<string, ScenePoint>()

watch(
  placements,
  (next) => {
    const targets = new Map<string, ScenePoint>()
    const facing = new Map<string, boolean>()
    const durations = new Map<string, number>()
    for (const [id, placement] of next) {
      const previous = lastPoints.get(id)
      if (previous) {
        // Captured at the moment the target moves: once the sprite has arrived
        // there is no direction left to read off two identical points.
        facing.set(id, walkFacesLeft(previous, placement.point, placement.facesLeft))
        durations.set(id, walkDurationMs(previous, placement.point))
      }
      lastPoints.set(id, placement.point)
      targets.set(id, placement.point)
    }
    for (const id of [...lastPoints.keys()]) {
      if (!next.has(id)) lastPoints.delete(id)
    }
    travelFacesLeft.value = facing
    walkMs.value = durations
    walkBoard.sync(targets)
  },
  { immediate: true }
)

interface SceneSlot {
  dwarf: Dwarf
  left: number
  bottom: number
  scale: number
  zIndex: number
  facesLeft: boolean
  walking: boolean
  walkMs: number
  /** This dwarf's index among sharers of its anchor — see lib/bubbleLayout.ts (#43). */
  shareIndex: number
}

/** Every dwarf, resolved to the box coordinates and depth it should be drawn at. */
const slots = computed<SceneSlot[]>(() => {
  const box = boxSize.value
  const { band } = layout.value
  const result: SceneSlot[] = []
  for (const dwarf of props.mine.dwarfs) {
    const placement = placements.value.get(dwarf.id)
    if (!placement) continue
    const projected = clampToBox(
      projectToBox(placement.point, box, INTERIOR_ART_SIZE),
      SPRITE_MARGIN_X,
      SPRITE_MARGIN_Y
    )
    const walking = !reducedMotion.value && walkingIds.value.has(dwarf.id)
    result.push({
      dwarf,
      left: projected.x,
      // Positioned from the bottom so the dwarf's feet sit on the anchor, and
      // because `bottom` is the edge the painting itself is pinned to.
      bottom: 100 - projected.y,
      scale: depthScale(band, placement.point.y),
      zIndex: depthOrder(band, placement.point.y),
      facesLeft: walking
        ? (travelFacesLeft.value.get(dwarf.id) ?? placement.facesLeft)
        : placement.facesLeft,
      walking,
      walkMs: reducedMotion.value ? 0 : (walkMs.value.get(dwarf.id) ?? 0),
      shareIndex: placement.shareIndex
    })
  }
  /*
   * Painted far to near. `zIndex` already stacks them correctly, but matching
   * DOM order to depth means the scene still reads right if anything ever
   * flattens the z-indexes — and it makes the rendered order say out loud what
   * the depth sorting is doing.
   *
   * Ties break on id, not on arrival order: two dwarfs at the same depth are
   * common (the veins are paired), and leaving their order to however the poll
   * happened to list them would reshuffle the DOM on every refresh.
   */
  return result.sort((a, b) => b.bottom - a.bottom || a.dwarf.id.localeCompare(b.dwarf.id))
})

/* The ore piles stand on their own authored spot, and are depth-sorted with the crew. */
const depositAnchor = computed(() => anchorPool(layout.value, 'deposit')[0])
const pilePoint = computed(() =>
  clampToBox(projectToBox(depositAnchor.value, boxSize.value, INTERIOR_ART_SIZE), 8, 5)
)
const pileZIndex = computed(() => depthOrder(layout.value.band, depositAnchor.value.y))

/**
 * One mound per material this mine has actually produced, poorest first.
 *
 * Read from `mine.materials` — the persisted ledger — rather than from the live
 * `tokensObserved` gauge the header chip shows: the deposit survives a dwarf
 * leaving and an app restart, and a mine that grew from copper into silver
 * keeps its copper standing beside its silver instead of having it silently
 * reinterpreted (see #22).
 *
 * A material below one whole nugget is left out by vaultRows, so a fresh mine
 * simply has no deposit yet rather than an empty labelled patch of floor.
 */
const materialPiles = computed(() => vaultRows(props.mine.materials))

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
    <header class="scene-header">
      <button class="back-button" type="button" aria-label="Back to the map" @click="emit('back')">
        &larr; Map
      </button>
      <div class="scene-heading">
        <h1 id="mine-title">{{ mine.name }}</h1>
        <p class="scene-path">{{ mine.path }}</p>
      </div>
      <!-- This mine's own vault: what it has mined, split by material. -->
      <VaultChip
        class="scene-vault"
        variant="inline"
        :tokens-observed="mine.tokensObserved"
        :materials="mine.materials"
      />
      <span class="tier-badge">{{ tierLabel(mine.tier) }}</span>
    </header>

    <div ref="caveRef" class="cave">
      <img class="cave-art" :src="interiorSrc" alt="" aria-hidden="true" draggable="false" />
      <!-- Keeps the crew readable against a busy painting. -->
      <div class="cave-vignette" aria-hidden="true"></div>
      <!--
        The deposit: what this mine has mined, on its authored patch of floor.

        One labelled mound PER MATERIAL, side by side — deliberately not one
        blended heap. Materials never convert into one another (see #22), so a
        single pile would draw a conversion the vault refuses; here the coal
        stands beside the gold exactly as it does in the ledger, and each mound
        says its own name and its own count on hover.
      -->
      <div
        v-if="materialPiles.length > 0"
        class="ore-pile"
        role="group"
        aria-label="Ore mined in this mine"
        :style="{
          left: `${pilePoint.x}%`,
          bottom: `${100 - pilePoint.y}%`,
          zIndex: pileZIndex
        }"
      >
        <NuggetPile
          v-for="row in materialPiles"
          :key="row.material"
          :material="row.material"
          :tokens="row.tokens"
          :seed="mine.id"
        />
      </div>

      <!-- idle mine: nobody on the floor -->
      <div v-if="mine.dwarfs.length === 0" class="mine-idle">
        <p>Nobody is working this mine yet.</p>
      </div>

      <!-- the crew, each on the painted feature its status sends it to -->
      <div v-else class="crew-floor" :class="{ 'is-still': reducedMotion }">
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
            anchored
            :walking="slot.walking"
            :faces-left="slot.facesLeft"
            :depth-scale="slot.scale"
            @activate="emit('activate', slot.dwarf)"
            @send-text="emit('send-text', slot.dwarf, $event)"
            @kick="emit('kick', slot.dwarf)"
            @bubble-hold="board.hold(slot.dwarf.id)"
            @bubble-release="board.release(slot.dwarf.id)"
          />
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.mine-scene {
  display: flex;
  flex-direction: column;
  min-height: 100%;
  padding: 14px 16px 16px;
}
.scene-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}
.back-button {
  -webkit-app-region: no-drag;
  padding: 6px 9px;
  border: 1px solid var(--line-soft);
  border-radius: 7px;
  color: var(--ink-dim);
  cursor: pointer;
  background: transparent;
  font-size: 12px;
  white-space: nowrap;
}
.back-button:hover {
  color: #fff;
  background: #4b3c28;
}
.back-button:focus-visible {
  outline: 2px solid #ffe29c;
  outline-offset: 2px;
}
.scene-heading {
  flex: 1;
  min-width: 0;
}
.scene-vault {
  flex: none;
}
.scene-heading h1 {
  overflow: hidden;
  margin: 0;
  font-size: 18px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.scene-path {
  overflow: hidden;
  margin: 2px 0 0;
  color: var(--ink-faint);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tier-badge {
  padding: 4px 9px;
  border: 1px solid var(--tier-accent);
  border-radius: 999px;
  color: var(--tier-accent);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  text-shadow: 0 0 8px var(--tier-glow);
}
.cave {
  position: relative;
  flex: 1;
  overflow: hidden;
  min-height: 320px;
  border: 1px solid var(--line-soft);
  border-radius: 14px;
  background: #171009;
  box-shadow: inset 0 0 48px #000c;
}
.cave-art {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  /*
   * Anchored to the bottom: the painted floor the dwarfs stand on lives in the
   * lowest band of the artwork and must never be the part that gets cropped.
   */
  object-position: 50% 100%;
  user-select: none;
}
.cave-vignette {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background:
    radial-gradient(110% 70% at 50% 40%, transparent 45%, #0a06034d 80%, #0a060399 100%),
    linear-gradient(transparent 55%, #0a0603a6);
}
/*
 * Sits on the authored deposit anchor (left/bottom come from the projected
 * point) and is depth-sorted with the crew, so a dwarf working farther back is
 * drawn behind the deposit and one resting in front of it is drawn over it.
 * `pointer-events` are deliberately on: the hover label is the affordance.
 *
 * The mounds are laid out in a row along the floor and aligned to their feet,
 * so a tall heap and a short one still stand on the same ground.
 *
 * The row grows RIGHTWARD from the anchor rather than centring on it, and the
 * half-mound margin is what puts the first heap on the authored spot. Centring
 * would be wrong here: the deposit anchor is the ground at the foot of the LEFT
 * ore shelf (see sceneLayout), so a row wide enough for all six materials would
 * hang off the left edge of the cave instead of piling up along the floor.
 */
.ore-pile {
  position: absolute;
  display: flex;
  align-items: flex-end;
  gap: 3px;
  /* Half of NuggetPile's own 48px box. */
  margin-left: -24px;
  cursor: help;
}
.mine-idle {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--ink-dim);
  font-size: 13px;
  text-align: center;
  text-shadow: 0 1px 4px #000;
}
.mine-idle p {
  margin: 0;
}
/*
 * No layout of its own any more: the crew is positioned individually against
 * the painting, so this is just the plane they live on.
 */
.crew-floor {
  position: absolute;
  inset: 0;
}
/*
 * One dwarf, standing on its anchor.
 *
 * `left`/`bottom` are animated rather than a transform on purpose. A transform
 * on this element would make it the containing block for the `position: fixed`
 * tooltip, action bar and expanded bubble inside DwarfSprite, and those are
 * placed in viewport coordinates by computeTooltipPlacement — they would all
 * land in the wrong place. At a handful of sprites in a small panel the cost of
 * animating offsets instead is not measurable.
 *
 * `--walk-ms` is the distance-derived duration from sceneMotion, so a dwarf
 * crossing the whole gallery takes longer than one shuffling along a vein.
 * `margin-left` centres the fixed 96px sprite on its anchor, and the negative
 * `margin-bottom` discounts the name label so the *feet* land on the spot.
 */
.scene-slot {
  position: absolute;
  width: 96px;
  margin-bottom: -14px;
  margin-left: -48px;
  transition:
    left var(--walk-ms, 0ms) linear,
    bottom var(--walk-ms, 0ms) linear;
}
/* Reduced motion: everyone is still placed in the cave, they just cut there. */
.crew-floor.is-still .scene-slot {
  transition: none;
}
@media (prefers-reduced-motion: reduce) {
  .scene-slot {
    transition: none;
  }
}
</style>
