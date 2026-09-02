<script setup lang="ts">
import { computed } from 'vue'
import { cardArtFor, cardTierLabel } from '../../lib/browse/browseCards'
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
        <span v-if="activeAgents !== undefined" class="card-agents"
          >Active agents: {{ activeAgents }}</span
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
.card-agents {
  color: var(--color-cream);
  font-size: var(--text-meta);
}
</style>
