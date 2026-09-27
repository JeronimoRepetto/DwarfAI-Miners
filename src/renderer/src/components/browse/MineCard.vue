<script setup lang="ts">
/*
 * One mine on the Mines page (#635), `molecules/mine-card` in the design (W2): the tier art, the
 * tier chip and name on one line with the ⋯ menu beside them, one ore capsule per material, the
 * crew line of pills, and the progress at full width under both columns. A mine that waits on you
 * wears the heavy brass outline; the open mine wears four parchment brackets and aria-current,
 * never a colour (decision log, Selected mine mark). The whole card is one button, the menu a
 * separate one so neither nests in the other. What it shows is lib/browse/mineCard's.
 */
import { computed } from 'vue'
import TierChip from '../controls/TierChip.vue'
import OreCapsule from '../vault/OreCapsule.vue'
import StatePill from '../dwarf/StatePill.vue'
import TierProgress from './TierProgress.vue'
import MenuButton from '../overlay/MenuButton.vue'
import { MOUND_SRC } from '../../lib/art'
import { mineCardLabel, mineCardMenu, type MineCardView } from '../../lib/browse/mineCard'

const props = withDefaults(
  defineProps<{
    card: MineCardView
    open?: boolean
    /** A look forced without the pointer, as the UI kit's own states show it. */
    state?: 'hover' | 'active'
  }>(),
  { open: false, state: undefined }
)
const emit = defineEmits<{ open: [id: string]; remove: [id: string]; refuse: [id: string] }>()

const label = computed(() => mineCardLabel(props.card))
const menu = computed(() => mineCardMenu(props.card))
const blocked = computed(() => !props.card.enterable || props.card.state === 'unenterable')

// A press on a mine that cannot be entered opens nothing; the page says why (PANEL-QUESTIONS 6).
function enter(): void {
  if (!blocked.value) emit('open', props.card.id)
  else if (props.card.state === 'unenterable') emit('refuse', props.card.id)
}

// The menu holds one item today, Remove mine…, so any pick is the removal.
function pick(): void {
  emit('remove', props.card.id)
}
</script>

<template>
  <article
    class="dm-card m-mat m-brackets"
    :class="state ? 'is-' + state : undefined"
    :data-mine="card.id"
    :data-tier="card.tier"
    :data-state="card.state"
    :data-open="open ? 'true' : undefined"
    :data-needs="card.needs ? 'true' : 'false'"
  >
    <button
      class="dm-card__hit"
      type="button"
      :aria-label="label"
      :aria-current="open ? 'true' : undefined"
      :aria-disabled="blocked ? 'true' : undefined"
      :title="card.state === 'unenterable' ? card.reason : undefined"
      @click="enter"
    ></button>
    <div class="dm-card__art"><img :src="MOUND_SRC[card.tier]" alt="" /></div>
    <div class="dm-card__body">
      <div class="dm-card__title">
        <TierChip :tier="card.tier" />
        <h3 class="dm-card__name" :title="card.name">{{ card.name }}</h3>
        <MenuButton
          class="dm-card__menu"
          :items="menu"
          :title="'More for ' + card.name"
          size="sm"
          @pick="pick"
        />
      </div>
      <div class="dm-card__ore">
        <OreCapsule
          v-for="row in card.ore"
          :key="row.material"
          :material="row.material"
          :units="row.units"
        />
      </div>
      <div class="dm-card__crew">
        <StatePill
          v-for="pill in card.crew"
          :key="pill.text"
          :text="pill.text"
          :tone="pill.tone"
          :ask="pill.ask === true"
        />
      </div>
    </div>
    <p v-if="card.state === 'unenterable'" class="dm-card__note">
      <!-- A space parts the pill from the reason, as the design's note draws it. -->
      <StatePill text="Not enterable" tone="warn" icon="warning" />{{ ' ' + card.reason }}
    </p>
    <div v-else-if="card.state === 'unrecorded'" class="dm-card__progress">
      <p class="dm-card__note"><StatePill text="Working · not recorded yet" tone="info" /></p>
    </div>
    <div v-else-if="card.progress" class="dm-card__progress">
      <TierProgress v-bind="card.progress" />
    </div>
  </article>
</template>

<style scoped>
/* The design's mine-card.css, rule for rule and in its order. */
.dm-card {
  --mat-fill: var(--wood);
  --mat-hi: var(--wood-hi);
  --mat-lo: var(--wood-lo);
  --mat-edge: var(--rock-lo);
  display: grid;
  grid-template-columns: 120px minmax(0, 1fr);
  position: relative;
  gap: 8px 10px;
  padding: 8px;
  margin: 4px;
  transition: transform var(--dur-press) var(--ease-step);
}
.dm-card__hit {
  position: absolute;
  inset: 0;
  z-index: 0;
}
.dm-card__hit:focus-visible {
  outline-offset: 4px;
}
.dm-card > :not(.dm-card__hit) {
  position: relative;
  z-index: 1;
  pointer-events: none;
}
/* The menu button is MenuButton's own root (a fragment with its popover), so the card reaches
   it with :deep; the specificity it gains is what the design's later stylesheet gives it. */
.dm-card :deep(.dm-card__menu) {
  pointer-events: auto;
}
.dm-card:hover,
.dm-card.is-hover {
  --mat-edge: var(--brass-lo);
  --mat-fill: var(--wood-hi);
  --mat-hi: var(--wood-hi);
}
.dm-card:active:not([data-state='unenterable']),
.dm-card.is-active {
  transform: translateY(var(--px));
  --mat-hi: var(--wood-lo);
  --mat-lo: var(--wood-hi);
}
.dm-card::after {
  --br-l: 16px;
  inset: var(--px);
  z-index: 2;
}
.dm-card[data-open='true']::after {
  opacity: 1;
}
.dm-card[data-needs='true'] {
  --mat-edge: var(--brass);
  --mat-extra:
    0 -4px 0 0 var(--glow-brass), 0 4px 0 0 var(--glow-brass), -4px 0 0 0 var(--glow-brass),
    4px 0 0 0 var(--glow-brass);
}
.dm-card__art {
  width: 120px;
  height: 90px;
  display: grid;
  background: var(--rock);
  box-shadow:
    inset 2px 2px 0 0 var(--rock-lo),
    inset -2px -2px 0 0 var(--rock-hi);
  place-items: center;
  overflow: hidden;
}
.dm-card__art img {
  width: 112px;
  height: 84px;
  object-fit: contain;
}
.dm-card__body {
  display: grid;
  min-width: 0;
  gap: 6px;
  align-content: start;
}
.dm-card__title {
  display: flex;
  min-width: 0;
  gap: 6px;
  align-items: center;
}
.dm-card__name {
  flex: 1;
  min-width: 0;
  font: var(--fs-section) / 1.1 var(--f-label);
  color: var(--parchment);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dm-card :deep(.dm-card__menu) {
  margin: -4px -4px 0 0;
}
.dm-card__ore,
.dm-card__crew {
  display: flex;
  gap: 2px 4px;
  flex-wrap: wrap;
  align-items: center;
}
.dm-card__progress {
  grid-column: 1 / -1;
}
.dm-card__note {
  font: var(--fs-meta) / 1.3 var(--f-meta);
  color: var(--ink-soft);
  grid-column: 1 / -1;
}
.dm-card[data-state='unenterable'] {
  --mat-fill: var(--rock);
  --mat-hi: var(--rock-hi);
  --mat-lo: var(--rock-lo);
  --mat-edge: var(--wood-hi);
}
.dm-card[data-state='unenterable'] .dm-card__art img {
  opacity: 0.35;
}
.dm-card[data-state='unenterable'] .dm-card__name {
  color: var(--ink-faint);
}
.dm-card[data-state='unenterable'] .dm-card__hit {
  cursor: not-allowed;
}
</style>
