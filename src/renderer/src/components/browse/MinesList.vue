<script setup lang="ts">
/*
 * The Mines page (#635), `organisms/mines-list` in the design (W1·1–4): the page header with
 * search, sort and add; the tier chips in canonical order; every mine as a card; and, in a quiet
 * corner, the count and the tier and ore explainer. Every card is built once: a search, a chip or
 * a sort only hides and reorders them (screens/browse.md). Removing a mine confirms first; a
 * worktree picked by Add asks which project was meant (#348). What is shown is
 * lib/browse/minesList's; the reads and writes are the host's, through useProjectBrowse.
 */
import { computed, nextTick, ref, watch } from 'vue'
import PageHeader from '../shell/PageHeader.vue'
import ChoiceChip from '../controls/ChoiceChip.vue'
import ActionButton from '../controls/ActionButton.vue'
import ModalDialog from '../overlay/ModalDialog.vue'
import MineCard from './MineCard.vue'
import TierInfo from './TierInfo.vue'
import {
  REMOVE_BODY,
  countText,
  emptyState,
  filterCards,
  nextSort,
  removeTitle,
  sortCards,
  sortLabel,
  type MineSort
} from '../../lib/browse/minesList'
import type { MineCardView } from '../../lib/browse/mineCard'
import { designTierLabel } from '../../lib/presentation'
import { worktreeQuestionBody } from '../../lib/worktree'
import { MINE_TIERS } from '../../types'
import type { MineTier, MineWorktreeOf } from '../../types'

const props = withDefaults(
  defineProps<{
    /** Every mine, built once; the page filters and orders them. */
    cards: MineCardView[]
    openId: string | null
    search: string
    tier: MineTier | null
    sort: MineSort
    /** True while main shows the folder picker or adopts a project (#85). */
    adding?: boolean
    loading?: boolean
    /** Why the list could not be read; a refusal is never an empty list. */
    error?: string | null
    /** Why the last add did not happen; nothing for a cancelled picker. */
    addError?: string | null
    /** True while main is carrying out a confirmed removal (#169). */
    removing?: boolean
    removeError?: string | null
    /** The worktree the last add landed on, while the page asks about it (#348). */
    worktreeQuestion?: MineWorktreeOf | null
    /** A mine just added: its card scrolls into view. */
    revealId?: string | null
  }>(),
  {
    adding: false,
    loading: false,
    error: null,
    addError: null,
    removing: false,
    removeError: null,
    worktreeQuestion: null,
    revealId: null
  }
)

const emit = defineEmits<{
  search: [text: string]
  tier: [tier: MineTier | null]
  sort: [mode: MineSort]
  add: []
  open: [id: string]
  remove: [id: string]
  'open-main-project': []
  'dismiss-worktree': []
}>()

const ordered = computed(() => sortCards(props.cards, props.sort))
const shownIds = computed(
  () => new Set(filterCards(props.cards, props.search, props.tier).map((c) => c.id))
)
const empty = computed(() =>
  props.error !== null || props.loading
    ? undefined
    : emptyState({
        query: props.search,
        tier: props.tier,
        shown: shownIds.value.size,
        total: props.cards.length
      })
)

const TIER_FILTERS: { tier: MineTier | null; label: string }[] = [
  { tier: null, label: 'All' },
  ...MINE_TIERS.map((tier) => ({ tier, label: designTierLabel(tier) }))
]

function clearSearch(): void {
  emit('search', '')
  emit('tier', null)
}

/*
 * The mine awaiting its removal confirmation, by id, resolved against the cards on screen: once
 * the removal lands and the list comes back without it, the dialog has nothing left to name and
 * closes by itself (#169).
 */
const removingId = ref<string | null>(null)
const pendingRemoval = computed(() =>
  removingId.value === null ? undefined : props.cards.find((c) => c.id === removingId.value)
)
const removeActions = computed(() => [
  { label: 'Cancel' },
  { label: 'Remove mine', variant: 'danger' as const, disabled: props.removing }
])

function removalAction(index: number): void {
  if (index === 0) removingId.value = null
  else if (pendingRemoval.value && !props.removing) emit('remove', pendingRemoval.value.id)
}

const worktreeActions = computed(() => [
  { label: 'Cancel' },
  { label: 'Open the main project', variant: 'primary' as const, disabled: props.adding }
])

function worktreeAction(index: number): void {
  if (index === 0) emit('dismiss-worktree')
  else if (!props.adding) emit('open-main-project')
}

const tierInfoOpen = ref(false)

const listEl = ref<HTMLElement | null>(null)
watch(
  () => [props.revealId, props.cards.length] as const,
  async ([id]) => {
    if (id === null) return
    await nextTick()
    const el = listEl.value?.querySelector<HTMLElement>('[data-mine="' + CSS.escape(id) + '"]')
    el?.scrollIntoView?.({ block: 'nearest' })
  }
)
</script>

<template>
  <section class="dm-mines" aria-label="Mines">
    <PageHeader
      title="Mines"
      search
      :search-value="search"
      :sort-label="sortLabel(sort)"
      add-label="Add a mine"
      :add-disabled="adding"
      @search="emit('search', $event)"
      @sort="emit('sort', nextSort(sort))"
      @add="emit('add')"
    />
    <div class="dm-mines__chips" role="radiogroup" aria-label="Filter by tier">
      <ChoiceChip
        v-for="chip in TIER_FILTERS"
        :key="chip.label"
        :label="chip.label"
        :tier="chip.tier ?? undefined"
        role="radio"
        :pressed="chip.tier === tier"
        :data-value="chip.tier ?? 'all'"
        @click="emit('tier', chip.tier)"
      />
    </div>
    <div ref="listEl" class="dm-mines__list" role="list" aria-label="Mines">
      <!-- Loading and failure have no design of their own: plain lines, as the page had them. -->
      <p v-if="error" class="dm-mines__notice" role="alert">{{ error }}</p>
      <p v-if="addError" class="dm-mines__notice" role="alert">{{ addError }}</p>
      <MineCard
        v-for="view in ordered"
        v-show="shownIds.has(view.id)"
        :key="view.id"
        role="listitem"
        :card="view"
        :open="view.id === openId"
        @open="emit('open', $event)"
        @remove="removingId = $event"
      />
      <div v-if="empty" class="dm-empty">
        <p class="dm-empty__title">{{ empty.title }}</p>
        <p class="dm-empty__text">{{ empty.text }}</p>
        <ActionButton v-if="empty.action === 'clear'" label="Clear search" @click="clearSearch" />
        <ActionButton
          v-else-if="empty.action === 'add'"
          label="Add a mine"
          variant="primary"
          :disabled="adding"
          @click="emit('add')"
        />
      </div>
      <p v-if="loading" class="dm-mines__notice" role="status">Reading your projects...</p>
    </div>
    <div class="dm-mines__foot">
      <span class="dm-mines__count">{{ countText(shownIds.size, cards.length) }}</span>
      <ActionButton icon="info" size="sm" title="Tiers and ore" @click="tierInfoOpen = true" />
    </div>

    <ModalDialog
      :open="pendingRemoval !== undefined"
      :title="pendingRemoval ? removeTitle(pendingRemoval.name) : ''"
      danger
      :actions="removeActions"
      @action="removalAction"
      @cancel="removingId = null"
    >
      <p>{{ REMOVE_BODY }}</p>
      <p v-if="removeError" role="alert">{{ removeError }}</p>
    </ModalDialog>
    <ModalDialog
      :open="worktreeQuestion !== null"
      title="This folder is a worktree"
      :actions="worktreeActions"
      @action="worktreeAction"
      @cancel="emit('dismiss-worktree')"
    >
      <p v-if="worktreeQuestion">{{ worktreeQuestionBody(worktreeQuestion) }}</p>
    </ModalDialog>
    <ModalDialog
      :open="tierInfoOpen"
      title="Tiers and ore"
      wide
      :actions="[{ label: 'Close' }]"
      @action="tierInfoOpen = false"
      @cancel="tierInfoOpen = false"
    >
      <TierInfo />
    </ModalDialog>
  </section>
</template>

<style scoped>
/* The design's mines-list.css, rule for rule. */
.dm-mines {
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr) auto;
  height: 100%;
  min-height: 0;
  gap: 4px;
}
.dm-mines__chips {
  display: flex;
  gap: 0 2px;
  padding: 0 2px;
  flex-wrap: wrap;
}
.dm-mines__list {
  display: grid;
  padding: 4px 6px 8px 2px;
  gap: 4px;
  overflow-y: auto;
  overflow-x: hidden;
  align-content: start;
  scrollbar-gutter: stable;
}
.dm-mines__foot {
  display: flex;
  padding: 0 4px;
  justify-content: space-between;
  align-items: center;
}
.dm-mines__count {
  font: var(--fs-meta) / 1 var(--f-meta);
  color: var(--ink-faint);
}
.dm-empty {
  display: grid;
  gap: 10px;
  padding: 48px 16px;
  justify-items: center;
  text-align: center;
}
.dm-empty__title {
  font: var(--fs-headline) / 1.1 var(--f-display);
  color: var(--gold);
}
.dm-empty__text {
  max-width: 30ch;
  font: var(--fs-body) / 1.35 var(--f-meta);
  color: var(--ink-soft);
  overflow-wrap: anywhere;
}
.dm-mines__notice {
  padding: 4px;
  font: var(--fs-meta) / 1.3 var(--f-meta);
  color: var(--ink);
}
</style>
