<script setup lang="ts">
/*
 * Veta's "+N" (`DS/docs/components.md`, Veta strip, `.dm-veta__more` and "As built"; `DS/docs/screens/veta.md` V1 item
 * 3; 07 machine 25; US-VETA-006; ISSUE-291): the count of the mines at work folded off the strip, and the list of them
 * its hover shows. Presentational: its container (`VetaApp`) holds the machine and says when the list shows.
 *
 * - "+N" is never a Tab stop, nor is anything in its list (PO #55, NFR-A11Y-15): a keyboard-only person cannot open
 *   it, an accepted gap. It is named for assistive technology with the folded mines' names.
 * - The list is the design's tooltip card (`molecules/tooltip`: titled "More mines at work", one row per folded mine
 *   with its tier chip, its name and "? needs you" or "`<n>` at work", then "Scroll over Veta to cycle"), on the
 *   screen side of "+N", centred on it, 8 px from it. It shows 300 ms after the pointer arrives (`--dur-tip-delay`),
 *   and its transparent padding toward "+N" keeps the hover alive between the two. It is always laid out, hidden
 *   until shown, so the window holds its room beforehand and a hover never resizes it (07 §24 I-22).
 * - Unlike the design's hover tooltip, each row is a pointer target (OQ-76 A): a click asks for that mine (S25.11).
 * - The needs-you signal (OQ-76 A; US-VETA-006.AC08): when a folded mine's dwarf needs the person, "+N" takes the
 *   design's `[data-attention]` look (a brass edge and brass text), and so does that mine's row.
 */
import { formatList, t, type MineId, type VetaDock } from '@dwarfai/contracts'
import { computed } from 'vue'
import type { VetaChamberView } from '../../lib/veta/lifeState'
import type { MineTier } from '../../types'
import TierChip from '../controls/TierChip.vue'

const props = defineProps<{
  /** The folded chambers, in mine order. */
  folded: readonly VetaChamberView[]
  /** The list shows (07 machine 25 `list-shown`). */
  shown: boolean
  edge: VetaDock['edge']
  /** The screen side of the strip, where the list stands. */
  side: 'top' | 'bottom' | 'left' | 'right'
}>()

const emit = defineEmits<{
  enter: []
  leave: []
  pick: [mineId: MineId]
}>()

const attention = computed(() => props.folded.some((chamber) => chamber.attention))
const label = computed(() =>
  t('veta.more.label', {
    count: props.folded.length,
    names: formatList(props.folded.map((chamber) => chamber.mine.name))
  })
)
const tierOf = (chamber: VetaChamberView): MineTier => chamber.mine.tier ?? 'bronze'
</script>

<template>
  <div
    class="veta-more"
    :data-side="side"
    data-veta-more-slot
    data-veta-part="more"
    @pointerenter="emit('enter')"
    @pointerleave="emit('leave')"
  >
    <span
      class="veta-more__face m-mat"
      :data-edge="edge"
      :data-attention="attention ? 'true' : 'false'"
      role="img"
      :aria-label="label"
      data-veta-more
      >{{ t('veta.more.count', { count: folded.length }) }}</span
    >
    <div class="veta-more__list" :data-shown="shown ? 'true' : 'false'" data-veta-more-list>
      <div class="veta-more__card m-mat m-raised">
        <div class="veta-more__title">{{ t('veta.more.title') }}</div>
        <button
          v-for="chamber in folded"
          :key="chamber.mine.id"
          type="button"
          tabindex="-1"
          class="veta-more__row veta-more__item"
          :data-mine-id="chamber.mine.id"
          :data-attention="chamber.attention ? 'true' : 'false'"
          data-veta-more-item
          @click="emit('pick', chamber.mine.id)"
        >
          <span class="veta-more__mine"
            ><TierChip :tier="tierOf(chamber)" />{{ chamber.mine.name }}</span
          >
          <b>{{
            chamber.attention
              ? t('veta.more.needsYou')
              : t('veta.more.atWork', { count: chamber.dwarfs.length })
          }}</b>
        </button>
        <div class="veta-more__row t-faint">{{ t('veta.more.hint') }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.veta-more {
  position: relative;
  display: flex;
  flex: none;
}

/* `.dm-veta__more`: 40 × 44 (44 × 32 on a side edge) on the control material, its count in the label face. */
.veta-more__face {
  --mat-fill: var(--control);
  --mat-hi: var(--control-hi);
  --mat-lo: var(--control-lo);
  --mat-edge: var(--rock-lo);
  display: grid;
  flex: none;
  place-items: center;
  box-sizing: border-box;
  width: 40px;
  height: 44px;
  margin: var(--px);
  font: 400 var(--fs-section) / 1 var(--f-label);
  color: var(--ink-soft);
  transition: transform var(--dur-press) var(--ease-step);
  user-select: none;
}

.veta-more__face[data-edge='left'],
.veta-more__face[data-edge='right'] {
  width: 44px;
  height: 32px;
}

.veta-more__face:hover {
  --mat-edge: var(--brass);
}

.veta-more__face:active {
  transform: translateY(var(--px));
}

/* `.dm-veta__more[data-attention="true"]`: the needs-you signal, a brass edge and brass text. */
.veta-more__face[data-attention='true'] {
  --mat-edge: var(--brass);
  color: var(--brass);
}

/*
 * The list's place: on the screen side, centred on "+N", 8 px from it (the design's tooltip gap); the 6 px padding
 * plus "+N"'s 2 px margin is that gap, transparent, so the pointer crosses it without leaving.
 */
.veta-more__list {
  position: absolute;
  z-index: 5;
  visibility: hidden;
  opacity: 0;
  transition:
    opacity var(--dur-fast) var(--ease-step),
    visibility 0s linear var(--dur-fast);
}

.veta-more__list[data-shown='true'] {
  visibility: visible;
  opacity: 1;
  transition:
    opacity var(--dur-fast) var(--ease-step) var(--dur-tip-delay),
    visibility 0s linear var(--dur-tip-delay);
}

.veta-more[data-side='top'] > .veta-more__list {
  bottom: 100%;
  left: 50%;
  padding-bottom: 6px;
  transform: translateX(-50%);
}

.veta-more[data-side='bottom'] > .veta-more__list {
  top: 100%;
  left: 50%;
  padding-top: 6px;
  transform: translateX(-50%);
}

.veta-more[data-side='left'] > .veta-more__list {
  right: 100%;
  top: 50%;
  padding-right: 6px;
  transform: translateY(-50%);
}

.veta-more[data-side='right'] > .veta-more__list {
  left: 100%;
  top: 50%;
  padding-left: 6px;
  transform: translateY(-50%);
}

/* `.dm-tip`, rule for rule, a pointer target here (OQ-76 A). */
.veta-more__card {
  --mat-fill: var(--wood);
  --mat-hi: var(--wood-hi);
  --mat-lo: var(--wood-lo);
  --mat-edge: var(--rock-lo);
  display: grid;
  min-width: 140px;
  max-width: 240px;
  gap: 4px;
  padding: 8px 10px;
  font: var(--fs-meta) / 1.35 var(--f-meta);
  color: var(--ink-soft);
  white-space: nowrap;
}

/* `.dm-tip__title`. */
.veta-more__title {
  display: flex;
  gap: 6px;
  align-items: center;
  font-size: var(--fs-section);
  color: var(--parchment);
}

/* `.dm-tip__row`. */
.veta-more__row {
  display: flex;
  gap: 12px;
  justify-content: space-between;
}

/* `.dm-tip__row b`. */
.veta-more__row b {
  font-weight: 400;
  color: var(--ink);
}

/* A row is a button: the row's look, no button chrome, and the hover edge of the strip's own parts. */
.veta-more__item {
  margin: 0;
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  color: inherit;
  text-align: start;
  cursor: pointer;
}

.veta-more__item:hover .veta-more__mine {
  color: var(--parchment);
}

.veta-more__mine {
  display: flex;
  gap: 6px;
  align-items: center;
}
</style>
