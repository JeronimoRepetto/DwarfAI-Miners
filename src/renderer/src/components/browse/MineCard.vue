<script setup lang="ts">
import { computed } from 'vue'
import { DIALOG_ICON_SRC, NUGGET_SRC, SLEEP_ICON_SRC, maskImageValue } from '../../lib/art'
import {
  cardArtFor,
  cardTierFor,
  cardTierLabel,
  nextLevelFor,
  type CardStatus
} from '../../lib/browse/browseCards'
import { orePileLabel } from '../../lib/presentation'
import { formatUnits, vaultRows } from '../../lib/vault/vault'
import type { ProjectSummary } from '../../types'

const props = defineProps<{
  project: ProjectSummary
  /**
   * The crew on this project right now, or undefined when the panel cannot
   * back a number — see activeAgentsFor(). Undefined prints no line at all,
   * because "Active agents: 0" is a claim and a missing count is not one.
   */
  activeAgents?: number
  /**
   * What the board says about this crew beyond its size, or undefined when the
   * panel could back no fact — see cardStatusFor(). Undefined draws no markers
   * at all, for the same reason an absent count prints no line.
   */
  status?: CardStatus
}>()

const emit = defineEmits<{ open: [projectId: string] }>()

/**
 * The one tier this card states, however it was arrived at (#153) — see
 * `cardTierFor`. Read three times over: `data-tier` carries the tier palette
 * from theme.css, the heading names it, and the art paints its entrance. All
 * three take the same answer, because a card cannot be gold in its painting and
 * untiered in its colours.
 */
const tier = computed(() => cardTierFor(props.project))
const tierLabel = computed(() => cardTierLabel(props.project))
const art = computed(() => cardArtFor(props.project))

/**
 * What this project has actually mined, one pile per material (#135, #139).
 *
 * Read through the vault's own `vaultRows` rather than off `project.materials`
 * directly, so the card cannot become a second answer to "how much ore is
 * this": the grain size per material, the poorest-first order and the rule
 * that a pile short of one whole nugget is not shown all stay in one module
 * (see lib/vault/vault.ts and #22). The card's job is the shape of the row.
 *
 * Empty means no row is drawn at all. That covers both a project the ledger
 * has never had a row for — `materials` absent, which is "never mined" and not
 * "mined zero" — and a row that exists but holds nothing yet.
 */
const resources = computed(() => vaultRows(props.project.materials))

/**
 * The progress bar and its `Next level: <cur>/<max>` label, or undefined for
 * a project no walk has weighed yet (#90, closing #135's seam below) — see
 * nextLevelFor for what cur/max/ratio mean and why uranium prints no boundary.
 */
const level = computed(() => nextLevelFor(props.project.weightBytes))

/*
 * Only a project with a mine on the board can be entered: the interior of a
 * project nobody is working is #85's scope, and a button that opened nothing
 * would be a dead affordance dressed as a working one.
 */
const enterable = computed(() => props.project.live)
</script>

<template>
  <li class="mine-card" :data-tier="tier">
    <component
      :is="enterable ? 'button' : 'div'"
      class="card-body"
      :type="enterable ? 'button' : undefined"
      :title="project.path"
      @click="enterable && emit('open', project.id)"
    >
      <img v-if="art" class="card-art" :src="art" alt="" aria-hidden="true" draggable="false" />
      <span class="card-text">
        <span class="card-heading">
          <span v-if="tierLabel" class="card-tier">{{ tierLabel }} mine -</span>
          <span class="card-name">{{ project.name }}</span>
        </span>
        <!--
          One capsule holding one entry per material, each with the painting
          and the compact count the vault chip draws. Aria-hidden throughout
          and named in words on the hover line, exactly as the chip does it —
          a screen reader gets the sentence, not five loose numbers.
        -->
        <span v-if="resources.length" class="card-resources">
          <span
            v-for="row in resources"
            :key="row.material"
            class="card-resource"
            :data-material="row.material"
            :title="orePileLabel(row.material, row.tokens)"
          >
            <img
              class="resource-nugget"
              :src="NUGGET_SRC[row.material]"
              alt=""
              aria-hidden="true"
              draggable="false"
            />
            <span class="resource-count">{{ formatUnits(row.units) }}</span>
          </span>
        </span>
        <!--
          `Active Agents` with the capital the MOCK draws. Both markdown
          sources write it lowercase; the maintainer ruled the mock is the
          visual truth for this panel, so the copy follows the picture.
        -->
        <span v-if="activeAgents !== undefined" class="card-agents"
          >Active Agents: {{ activeAgents }}</span
        >
      </span>
      <!--
        The mock's second column, right of the text and vertically centred
        (#90, closing #135's seam): a progress bar and its
        `Next level: <cur>/<max>` label. Undefined `level` means no walk has
        weighed this project yet — no bar and no label, same absence-over-
        invention rule every other unmeasured fact on this card already keeps.
      -->
      <span v-if="level" class="card-level">
        <span class="level-bar">
          <span class="level-fill" :style="{ width: `${level.ratio * 100}%` }"></span>
        </span>
        <span class="level-label">
          <span class="level-label-text">Next level:</span>
          <span class="level-label-value"
            >{{ level.currentKb }}/{{ level.nextBoundaryKb ?? 'infinite' }}</span
          >
        </span>
      </span>
      <!--
        The mock's lower-right corner. Drawn only where the board proved the
        fact, and the row itself disappears when it proved neither — a pair of
        empty corners would read as "checked, nothing to report" on a project
        nobody has looked at.
      -->
      <span v-if="status?.asking || status?.resting" class="card-status">
        <span
          v-if="status.asking"
          class="status-glyph status-asking"
          :style="{ '--status-icon': maskImageValue(DIALOG_ICON_SRC) }"
          title="An agent here is waiting on an answer"
        ></span>
        <span
          v-if="status.resting"
          class="status-glyph status-resting"
          :style="{ '--status-icon': maskImageValue(SLEEP_ICON_SRC) }"
          title="An agent here is resting"
        ></span>
      </span>
    </component>
  </li>
</template>

<style scoped>
.mine-card {
  height: var(--size-card-height);
  list-style: none;
  border: var(--border-highlight);
  border-radius: var(--radius-default);
  background: var(--color-panel);
}
.card-body {
  /* The corner markers hang off this box rather than off the text column. */
  position: relative;
  display: flex;
  gap: 10px;
  align-items: center;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  padding: 0 10px;
  border: 0;
  color: inherit;
  background: none;
  font: inherit;
  text-align: start;
}
button.card-body {
  cursor: pointer;
}
button.card-body:focus-visible {
  outline: var(--border-active);
  outline-offset: -4px;
  border-radius: var(--radius-default);
}
.card-art {
  flex: none;
  width: var(--size-card-art-width);
  height: var(--size-card-art-height);
  object-fit: contain;
  /* Pixel art: no blur between the source pixels when it is scaled. */
  image-rendering: pixelated;
  user-select: none;
}
.card-text {
  display: flex;
  flex-direction: column;
  gap: 6px;
  /* Lets the heading ellipsize instead of pushing the card wider. */
  min-width: 0;
}
.card-heading {
  display: flex;
  flex-wrap: wrap;
  gap: 0 6px;
  align-items: baseline;
  font-size: var(--text-title);
  line-height: 1.2;
}
.card-tier {
  color: var(--color-accent);
}
.card-name {
  overflow: hidden;
  color: var(--color-cream);
  text-overflow: ellipsis;
  white-space: nowrap;
}
/*
 * The mock draws the resources as ONE dark capsule holding every material,
 * not as one pill each. Its ground samples as #181410, which the foundations
 * table does not name; the panel's own #14100b is the nearest named value and
 * is what is used, rather than minting a token the design source has no word
 * for. Fully rounded ends are the capsule's own shape and not the shared 12px
 * radius, which on a 16px-high strip would not close the ends at all.
 */
.card-resources {
  display: flex;
  align-self: start;
  align-items: center;
  gap: 6px;
  padding: 2px 8px;
  border: 1px solid var(--color-control);
  border-radius: 999px;
  background: var(--color-panel-deep);
}
.card-resource {
  display: flex;
  align-items: center;
  gap: 2px;
}
.resource-nugget {
  display: block;
  width: 11px;
  height: auto;
  /* Pixel art: no blur between the source pixels when it is scaled. */
  image-rendering: pixelated;
  user-select: none;
}
/* The amber the design gives every figure; the ore itself is coloured by paint. */
.resource-count {
  color: var(--color-accent);
  font-size: var(--text-meta);
}
.card-agents {
  color: var(--color-cream);
  font-size: var(--text-meta);
}
/*
 * The mock's second column (#90): `flex: 1` gives it the row's remaining
 * width so the bar resizes with the card rather than being pinned to the
 * mock's own fixed screenshot width. Both children stay flush to this
 * column's own left edge, matching the mock, rather than being centred.
 */
.card-level {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
/*
 * 5px tall and fully rounded, sampled straight off the mock's pixels (#90):
 * at this height the shared 12px --radius-default would not close the ends,
 * same reasoning .card-resources already used for its own short capsule.
 */
.level-bar {
  overflow: hidden;
  width: 100%;
  height: 5px;
  border-radius: 999px;
  /* The mock's own track colour, sampled off its pixels: #14100b. */
  background: var(--color-panel-deep);
}
.level-fill {
  display: block;
  height: 100%;
  /* The mock's own fill colour, sampled off its pixels: #d19831. */
  background: var(--color-accent);
}
.level-label {
  display: flex;
  gap: 4px;
  font-size: var(--text-meta);
}
/*
 * Sampled off the mock's own pixels (#90): the `Next level:` label prints in
 * accent and the cur/max figures print in cream, which is the OPPOSITE of the
 * one blanket `10px #fae2b6` components.md gives this whole metadata row.
 * The pixels are the visual truth this panel already defers to elsewhere
 * (see the Active Agents capitalisation above), so the split follows them.
 */
.level-label-text {
  color: var(--color-accent);
}
.level-label-value {
  color: var(--color-cream);
}
/*
 * The mock parks both markers against the card's lower-right corner, clear of
 * the text column — `margin-top: auto` inside the flex row would only push
 * them down, so the row is placed against the card itself.
 */
.card-status {
  position: absolute;
  right: var(--space-settings);
  bottom: 6px;
  display: flex;
  gap: 8px;
  align-items: end;
}
/*
 * Both glyphs are the designer's own SVGs through a mask. The mock draws them
 * in accent amber; the component table's cream/white rule is about the status
 * icons INSIDE a mine, where a worker and a foreman have to be told apart, and
 * a card names no single dwarf to tell apart.
 */
.status-glyph {
  display: block;
  background: var(--color-accent);
  mask: var(--status-icon) center / contain no-repeat;
}
.status-asking {
  width: var(--size-icon);
  height: var(--size-icon);
}
/* The source gives the sleep marker its own, smaller size. */
.status-resting {
  width: var(--size-sleep-icon);
  height: var(--size-sleep-icon);
}
</style>
