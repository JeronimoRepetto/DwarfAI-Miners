<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { ADD_ICON_SRC, SORT_ICON_SRC, maskImageValue } from '../../lib/art'
import { browseRows } from '../../lib/browse/boardRows'
import { TIER_CHIPS, activeAgentsFor, cardStatusFor } from '../../lib/browse/browseCards'
import type { Mine, MineTier, ProjectSortDirection, ProjectSummary } from '../../types'
import MineCard from './MineCard.vue'

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
  /** True while main is showing the folder picker (#85). */
  adding: boolean
  /** Why the last adopt did not happen; null for a cancelled picker as well as for a success. */
  addError: string | null
}>()

const emit = defineEmits<{
  search: [text: string]
  tier: [tier: MineTier | null]
  'toggle-direction': []
  'load-more': []
  add: []
  open: [projectId: string]
}>()

/*
 * The empty state is for a browse that was ANSWERED and found nothing. A
 * refusal is zero rows too, and rendering it the same way would tell a user
 * their history is gone (see ProjectQueryResult.answered).
 */
/**
 * The rows on screen: the page the store answered with, plus every mine on the
 * board it has no row for (#165). See lib/browse/boardRows.ts for the rule —
 * this list and the map are one world, so nothing stands on the map without a
 * card here.
 */
const rows = computed(() => browseRows(props.projects, props.mines, props))

const empty = computed(() => !props.loading && props.error === null && rows.value.length === 0)

const sortLabel = computed(() =>
  props.direction === 'desc' ? 'Most recent activity first' : 'Least recent activity first'
)

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
      <!--
        The design draws this control as the `filter.svg` glyph and no words at
        all, so the direction moved to the hover line: the accessible name has
        to stay stable for anyone navigating by it, and the title is what says
        which way the list currently runs (the same split the pin button uses).
      -->
      <button
        class="sort-control"
        type="button"
        aria-label="Order by last activity"
        :title="sortLabel"
        @click="emit('toggle-direction')"
      >
        <span
          class="control-glyph"
          :style="{ '--control-icon': maskImageValue(SORT_ICON_SRC) }"
          aria-hidden="true"
        ></span>
      </button>
      <!--
        Adopt a folder as a mine (#85). Main opens the OS picker itself, so
        this asks and names no path; it is disabled while that picker is up,
        because it is modal there and a queued second one would reopen it.
      -->
      <button
        class="add-control"
        type="button"
        aria-label="Add a project"
        title="Add a project folder"
        :disabled="adding"
        @click="emit('add')"
      >
        <!--
          `add.svg` is a filled disc with the plus cut OUT of it, so the mask
          paints the disc amber and the notch lets the ground through — which
          is exactly the round + the mock draws, with no second shape of ours.
        -->
        <span
          class="control-glyph"
          :style="{ '--control-icon': maskImageValue(ADD_ICON_SRC) }"
          aria-hidden="true"
        ></span>
      </button>
    </header>
    <!-- The accent rule the mock draws under the header, above the chips. -->
    <div class="header-divider" aria-hidden="true"></div>
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
      <!--
        A refused folder is its own fact: the list beside it was read fine, and
        it must not stand in for the empty state either. A cancelled picker
        never reaches here at all — it arrives as no notice.
      -->
      <p v-if="addError" class="add-error" role="alert">{{ addError }}</p>
      <p v-if="empty" class="panel-empty">
        Nothing here<br />
        Add your project.
      </p>
      <ul v-if="rows.length" class="card-list">
        <MineCard
          v-for="row in rows"
          :key="row.id"
          :project="row"
          :unrecorded="row.unrecorded"
          :active-agents="activeAgentsFor(row, mines)"
          :status="cardStatusFor(row, mines)"
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
/*
 * The mock sets the title at the same size as a card's tier and name, which the
 * source table gives as 19px — measured off the export, the two rows of pixels
 * are the same height. It is deliberately NOT the 24px headline: that size
 * belongs to the modal and empty-state copy, and this panel draws both.
 */
.panel-title {
  margin: 0;
  color: var(--color-accent);
  font-size: var(--text-title);
  font-weight: 400;
  line-height: 1;
}
/*
 * The field's ground samples as #272015 in the export, not the #2b2119 the
 * component table gives the search field — the mock is the visual truth for
 * this panel, and #272015 is the source's own control colour rather than a
 * value invented to match a screenshot.
 */
.search-field {
  box-sizing: border-box;
  flex: 1;
  min-width: 0;
  height: var(--size-search-height);
  padding: 0 10px;
  border: var(--border-active);
  border-radius: var(--radius-default);
  color: var(--color-cream);
  background: var(--color-control);
  font: inherit;
  font-size: var(--text-meta);
}
/*
 * The mock draws the placeholder at full cream, which no browser default does
 * — every one of them dims it — so it has to be said out loud, opacity
 * included (Firefox applies its own).
 */
.search-field::placeholder {
  color: var(--color-cream);
  opacity: 1;
}
/*
 * Both header controls are bare glyphs in the mock — no border, no surface, no
 * hit-target box drawn around them. They sit at the shell's icon size, which is
 * the one the source gives every SVG in `docs/assets/icons`.
 */
.sort-control,
.add-control {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  cursor: pointer;
  background: none;
}
.control-glyph {
  display: block;
  width: var(--size-icon);
  height: var(--size-icon);
  background: var(--color-accent);
  mask: var(--control-icon) center / contain no-repeat;
}
/*
 * The disabled model the source gives every other control: the glyph drops to
 * the control colour, which on this ground reads as switched off rather than
 * as missing.
 */
.add-control:disabled {
  cursor: default;
}
.add-control:disabled .control-glyph {
  background: var(--color-control);
}
.sort-control:focus-visible,
.add-control:focus-visible {
  outline: 2px solid var(--color-cream);
  outline-offset: 2px;
}
/*
 * The rule under the header row. 2px is the weight every other line in the
 * source carries; the source names no divider height for this screen, so the
 * shared border weight is what it borrows rather than a number of its own.
 */
.header-divider {
  flex: none;
  height: 2px;
  background: var(--color-accent);
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
/*
 * The selected chip also carries the card surface behind it in the mock, which
 * the component table leaves out — sampled off the export, the ground under
 * `All` is #2b2119 and under every other chip it is the panel's own #14100b.
 */
.tier-chip.is-selected {
  border-color: var(--color-accent);
  color: var(--color-cream);
  background: var(--color-panel);
}
/*
 * The list region is the panel's one scroll area, and it owns all the height
 * the header and chips do not — which is what lets the empty-state message
 * sit in the middle of it rather than under the chips.
 */
.panel-list {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  overflow-y: auto;
}
.card-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
  padding: 0;
}
/*
 * The two-line invitation, centred in the empty list the way the export draws
 * it. `24px #fae2b6` is the one empty state the design source specifies
 * outright (screens/browse.md), wording included.
 */
.panel-empty {
  margin: auto 0;
  padding: 0 10px;
  color: var(--color-cream);
  font-size: var(--text-headline);
  line-height: 1.4;
  text-align: center;
}
.panel-error,
.add-error,
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
