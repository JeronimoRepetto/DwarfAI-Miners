<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { TIER_CHIPS, activeAgentsFor } from '../../lib/browse/browseCards'
import type { Mine, MineTier, ProjectSortDirection, ProjectSummary } from '../../types'
import MineCard from './MineCard.vue'
import '../../assets/design-tokens.css'

const props = defineProps<{
  projects: ProjectSummary[]
  /** The board this poll produced, joined by id for the live crew counts. */
  mines: Mine[]
  search: string
  tier: MineTier | null
  direction: ProjectSortDirection
  loading: boolean
  error: string | null
  exhausted: boolean
}>()

const emit = defineEmits<{
  search: [text: string]
  tier: [tier: MineTier | null]
  'toggle-direction': []
  'load-more': []
  open: [projectId: string]
}>()

/*
 * The empty state is for a browse that was ANSWERED and found nothing. A
 * refusal is zero rows too, and rendering it the same way would tell a user
 * their history is gone (see ProjectQueryResult.answered).
 */
const empty = computed(() => !props.loading && props.error === null && props.projects.length === 0)

const sortLabel = computed(() => (props.direction === 'desc' ? 'Newest first' : 'Oldest first'))

const sentinel = ref<HTMLElement | null>(null)
let observer: IntersectionObserver | undefined

function stopWatching(): void {
  observer?.disconnect()
  observer = undefined
}

/*
 * The list pages as it is scrolled. The sentinel is removed once the list is
 * exhausted, so the element the observer watches disappears with the reason to
 * watch it. Guarded because IntersectionObserver is a browser API a test
 * environment need not provide — without it the loaded pages still render, they
 * simply stop growing.
 */
watch(sentinel, (element) => {
  stopWatching()
  if (element === null || typeof IntersectionObserver === 'undefined') return
  observer = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) emit('load-more')
  })
  observer.observe(element)
})

/*
 * A page that did not push the sentinel off screen delivers no new
 * intersection, and the list would stall with the sentinel still in view.
 * Re-observing is how an observer is asked to redeliver the current state; the
 * paging still terminates, because the sentinel goes with the last page.
 */
watch(
  () => props.projects.length,
  () => {
    const element = sentinel.value
    if (observer === undefined || element === null) return
    observer.unobserve(element)
    observer.observe(element)
  }
)

onBeforeUnmount(stopWatching)
</script>

<template>
  <section class="mines-panel">
    <header class="panel-header">
      <h2 class="panel-title">Mines</h2>
      <input
        class="search-field"
        type="search"
        :value="search"
        placeholder="Search by name"
        aria-label="Search mines by name"
        @input="emit('search', ($event.target as HTMLInputElement).value)"
      />
      <button
        class="sort-control"
        type="button"
        aria-label="Order by date added"
        @click="emit('toggle-direction')"
      >
        {{ sortLabel }}
      </button>
    </header>
    <div class="tier-chips" role="group" aria-label="Filter by mine type">
      <button
        v-for="chip in TIER_CHIPS"
        :key="chip.label"
        class="tier-chip"
        :class="{ 'is-selected': chip.tier === tier }"
        type="button"
        :aria-pressed="chip.tier === tier ? 'true' : 'false'"
        @click="emit('tier', chip.tier)"
      >
        {{ chip.label }}
      </button>
    </div>
    <div class="panel-list">
      <!--
        Loading and failure visuals are Unspecified in the design source, so
        they stay plain text in the existing register rather than inventing a
        styled state the rebuild would then have to undo.
      -->
      <p v-if="error" class="panel-error" role="alert">{{ error }}</p>
      <p v-if="empty" class="panel-empty">
        Nothing here<br />
        Add your project.
      </p>
      <ul v-if="projects.length" class="card-list">
        <MineCard
          v-for="project in projects"
          :key="project.id"
          :project="project"
          :active-agents="activeAgentsFor(project, mines)"
          @open="emit('open', $event)"
        />
      </ul>
      <p v-if="loading" class="panel-loading" role="status">Reading your projects...</p>
      <div
        v-if="!exhausted && !error"
        ref="sentinel"
        class="list-sentinel"
        aria-hidden="true"
      ></div>
    </div>
  </section>
</template>

<style scoped>
.mines-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
  padding: 10px;
  color: var(--color-cream);
  background: var(--color-panel-deep);
}
.panel-header {
  display: flex;
  gap: 10px;
  align-items: center;
}
.panel-title {
  margin: 0;
  color: var(--color-accent);
  font-size: var(--text-headline);
  font-weight: 400;
  line-height: 1;
}
.search-field {
  box-sizing: border-box;
  flex: 1;
  min-width: 0;
  height: var(--size-search-height);
  padding: 0 10px;
  border: var(--border-active);
  border-radius: var(--radius-default);
  color: var(--color-cream);
  background: var(--color-panel);
  font: inherit;
  font-size: var(--text-meta);
}
.sort-control {
  flex: none;
  height: var(--size-search-height);
  padding: 0 10px;
  border: var(--border-active);
  border-radius: var(--radius-default);
  color: var(--color-cream);
  cursor: pointer;
  background: var(--color-control);
  font: inherit;
  font-size: var(--text-meta);
}
.tier-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.tier-chip {
  height: var(--size-chip-height);
  padding: 0 12px;
  border: 2px solid var(--color-control);
  border-radius: var(--radius-default);
  color: var(--color-control);
  cursor: pointer;
  background: none;
  font: inherit;
  font-size: var(--text-meta);
}
.tier-chip.is-selected {
  border-color: var(--color-accent);
  color: var(--color-cream);
}
.panel-list {
  flex: 1;
  min-height: 0;
  /* The card list is the one scroll area of this screen. */
  overflow-y: auto;
}
.card-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
  padding: 0;
}
.panel-empty {
  margin: 0;
  padding: 40px 10px;
  color: var(--color-cream);
  font-size: var(--text-headline);
  line-height: 1.4;
  text-align: center;
}
.panel-error,
.panel-loading {
  margin: 0;
  padding: 10px 0;
  color: var(--color-cream);
  font-size: var(--text-meta);
}
.list-sentinel {
  height: 1px;
}
</style>
