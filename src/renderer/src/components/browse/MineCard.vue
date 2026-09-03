<script setup lang="ts">
import { computed } from 'vue'
import { NUGGET_SRC } from '../../lib/art'
import { cardArtFor, cardTierLabel } from '../../lib/browse/browseCards'
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
}>()

const emit = defineEmits<{ open: [projectId: string] }>()

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

/*
 * Only a project with a mine on the board can be entered: the interior of a
 * project nobody is working is #85's scope, and a button that opened nothing
 * would be a dead affordance dressed as a working one.
 */
const enterable = computed(() => props.project.live)
</script>

<template>
  <li class="mine-card" :data-tier="project.knownTier">
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
</style>
