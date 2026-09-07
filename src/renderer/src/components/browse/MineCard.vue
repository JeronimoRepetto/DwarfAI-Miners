<script setup lang="ts">
import { computed } from 'vue'
import {
  DELETE_ICON_SRC,
  DIALOG_ICON_SRC,
  NUGGET_SRC,
  SLEEP_ICON_SRC,
  maskImageValue
} from '../../lib/art'
import {
  cardArtFor,
  cardTierFor,
  cardTierLabel,
  isMeasuring,
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
  /**
   * True when this card was built from the BOARD because the projects store
   * holds no row for it (#165) — see lib/browse/boardRows.ts.
   *
   * The card says so out loud rather than passing the row off as a stored
   * project: everything a store row carries and this one cannot — a tier, a
   * weight, a vault, the date it was added — is missing for a reason, and a
   * card that stayed silent about it would look like a broken stored project
   * instead of an honest live one.
   */
  unrecorded?: boolean
}>()

const emit = defineEmits<{ open: [projectId: string]; remove: [projectId: string] }>()

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

/**
 * Whether this card is a mine still being measured (#165) — see `isMeasuring`.
 *
 * Drawn where the level column would be, because that is the fact it stands in
 * for: the bar is missing precisely because the walk has not finished. Mutually
 * exclusive with the bar by construction, not by ordering — the state is
 * defined as "the card has no tier to state", and a card with a bar has one.
 */
const measuring = computed(() => isMeasuring(props.project))

/*
 * Only a project with a mine on the board can be entered: the interior of a
 * project nobody is working is #85's scope, and a button that opened nothing
 * would be a dead affordance dressed as a working one.
 */
const enterable = computed(() => props.project.live)

/*
 * Whether this card has a mine that can be removed (#169).
 *
 * Every card but an unrecorded one: removal flags the projects row, and an
 * unrecorded card has none — main would answer "not tracking that", which is a
 * refusal dressed as an action. Such a mine leaves the board on its own when
 * its session ends (#165).
 *
 * The one that matters is the opposite of `enterable`: a mine nobody is working
 * cannot be entered at all, so an affordance living only inside the mine would
 * leave exactly the rows this exists to clear with no exit.
 */
const removable = computed(() => props.unrecorded !== true)
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
        A mine the walk has not finished measuring (#165). It stands in the
        level column because it stands in for the bar: a declared card with no
        tier, no entrance and no bar read as broken rather than as busy, and
        this says which it is without claiming anything about the outcome.
      -->
      <span v-else-if="measuring" class="card-measuring" role="status">Measuring the mine...</span>
      <!--
        A mine on the board that the projects store has no row for (#165). It
        takes the same column for the same reason: it is why there is no bar,
        no tier and no vault beside the name.
      -->
      <span v-else-if="unrecorded" class="card-unrecorded">Working now - not recorded yet</span>
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
    <!--
      Removing this mine (#169). A SIBLING of the card body, never a child:
      the body is a button when the mine can be entered, and a button inside a
      button is not valid HTML — which is also what keeps a press here from
      reaching the card's own open action, with no stopPropagation to remember.

      Upper-right because the lower-right corner already belongs to the status
      markers. The design source places no removal at all; see the amendment in
      `screens/browse.md`.
    -->
    <button
      v-if="removable"
      class="card-remove"
      type="button"
      :aria-label="`Remove the mine ${project.name}`"
      title="Stop tracking this mine"
      @click="emit('remove', project.id)"
    >
      <span
        class="remove-glyph"
        :style="{ '--remove-icon': maskImageValue(DELETE_ICON_SRC) }"
        aria-hidden="true"
      ></span>
    </button>
  </li>
</template>

<style scoped>
.mine-card {
  /* The removal control hangs off this box, so the card is what it is placed
     against — the body inside it is a grid whose tracks it must not join. */
  position: relative;
  height: var(--size-card-height);
  list-style: none;
  border: var(--border-highlight);
  border-radius: var(--radius-default);
  background: var(--color-panel);
}
/*
 * THREE DECLARED TRACKS, and every child placed in one by name (#156).
 *
 * It was a flex row, so the level column began wherever the text column
 * happened to stop — and that is whatever its longest line needs. Measured over
 * four cards in a real build, the same column started 348px, 339px and 634px
 * from its card's left edge, and was missing from the fourth. A card with no
 * painting slid its text into the painting's place and took everything after it
 * along.
 *
 * A track holds whether or not anything is in it, which is the whole point: a
 * project with no painting and a project nobody has walked both leave a gap
 * rather than closing the row up.
 *
 * The two flexible tracks share what is left equally rather than one taking
 * what the other did not want. No new pixel constant: the design source names a
 * card height and a painting width and no third width, and half of the rest is
 * within a few pixels of what the flex row was already giving the text.
 */
.card-body {
  /* The corner markers hang off this box rather than off the text column. */
  position: relative;
  display: grid;
  grid-template-columns: var(--size-card-art-width) minmax(0, 1fr) minmax(0, 1fr);
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
  grid-column: 1;
  width: 100%;
  height: var(--size-card-art-height);
  object-fit: contain;
  /* Pixel art: no blur between the source pixels when it is scaled. */
  image-rendering: pixelated;
  user-select: none;
}
.card-text {
  grid-column: 2;
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
 * The mock's second column (#90): its own declared track, so the bar resizes
 * with the card rather than being pinned to the mock's own fixed screenshot
 * width — and, since #156, so it begins in the same place on every card rather
 * than wherever the text column happened to stop. Both children stay flush to
 * this column's own left edge, matching the mock, rather than being centred.
 */
.card-level {
  grid-column: 3;
  display: flex;
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
  /*
    One line, always (#156). Wrapped, this label makes the column taller, and a
    taller column centred in a fixed-height card starts higher than the one on
    the card above it.
  */
  white-space: nowrap;
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
 * The measuring line takes the level column's own place and the level label's
 * accent, so a card waiting on its walk has the same shape as one that has
 * finished — the row does not reflow when the measurement lands (#165). One
 * line, always, for the same reason .level-label is.
 */
.card-measuring,
.card-unrecorded {
  grid-column: 3;
  min-width: 0;
  color: var(--color-accent);
  font-size: var(--text-meta);
  white-space: nowrap;
}
/*
 * Quieter than the measuring line: a mine being measured is about to become a
 * full card, and one the store has no row for may simply never be.
 */
.card-unrecorded {
  color: var(--color-tooltip-text);
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
/*
 * The removal control (#169), against the card's upper-right corner — the
 * opposite corner from the status markers, which own the lower-right.
 *
 * A bare glyph with no surface behind it, the treatment the source gives both
 * of the Mines header's own controls (see MinesPanel's .sort-control), and at
 * the same shared icon size. It is quieter than they are until it is hovered or
 * focused: it is the one destructive thing on this screen, and the mock draws
 * nothing here at all, so it should not compete with the mine's own name.
 */
.card-remove {
  position: absolute;
  top: 6px;
  right: var(--space-settings);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  cursor: pointer;
  background: none;
}
.remove-glyph {
  display: block;
  width: var(--size-sleep-icon);
  height: var(--size-sleep-icon);
  background: var(--color-control);
  mask: var(--remove-icon) center / contain no-repeat;
}
.card-remove:hover .remove-glyph,
.card-remove:focus-visible .remove-glyph {
  background: var(--color-accent);
}
.card-remove:focus-visible {
  outline: 2px solid var(--color-cream);
  outline-offset: 2px;
}
</style>
