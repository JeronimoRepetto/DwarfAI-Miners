<script setup lang="ts">
/*
 * The mine history (#635), `organisms/history-panel` in the design: a mine's past conversations,
 * read-only, one tab per dwarf (a tablist named "Dwarfs", ←/→ between tabs), the transcript and
 * each tab's last-message time. Opened from the mine toolbar. Replaces MineHistoryPanel.
 *
 * Nothing here can send: the maintainer ruled a composer out (#192), and a mine with no live dwarf
 * has nobody to send to. Which tab is open, how many rows it shows, how a time is spelled and which
 * mark a prompt wears are lib/history/mineHistory's; the rows fold their tool calls the way the
 * MessagePanel does (groupActivity). What it opens is App's: a step's own path (#279) and a link.
 *
 * Mounted per mine (App keys it), so opening it on another mine is a fresh panel on its first tab.
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import ActionButton from '../controls/ActionButton.vue'
import DwarfPortrait from '../dwarf/DwarfPortrait.vue'
import PixelIcon from '../icon/PixelIcon.vue'
import MarkdownBubble from '../message/MarkdownBubble.vue'
import {
  HISTORY_MARK,
  HISTORY_READ_ONLY_NOTE,
  HISTORY_SCOPE_NOTE,
  historyLabel,
  historyMarks,
  historyNote,
  historyTabLast,
  historyTabs,
  historyTitle,
  selectedSpeakerId,
  speakerHistoryNotice,
  speakerRows,
  type HistoryRow
} from '../../lib/history/mineHistory'
import { activityStepsLabel, groupActivity, type PanelEntry } from '../../lib/message/activityGroup'
import { isOpenablePath } from '../../lib/message/openablePath'
import { mineCrew } from '../../lib/scene/mineColumn'
import { sceneDwarfStatus } from '../../lib/scene/sceneDwarf'
import type { PortraitStatus } from '../../lib/dwarf/portrait'
import type { Mine, MineHistoryResult } from '../../types'

const props = defineProps<{
  mine: Mine
  /** What main read for this mine. Undefined while the read is in flight, which is its own answer. */
  history?: MineHistoryResult
  /** The refusal main gave for the last path this panel asked it to open (#279), by row key. */
  pathRefusal?: { key: string; reason: string }
}>()

const emit = defineEmits<{
  close: []
  /** A read or edit step's own path was pressed: the row's key and the step's exact target. */
  'open-path': [payload: { key: string; target: string }]
  /** A link in a message was pressed; App relays it to main, which opens it (#347). */
  'open-link': [href: string]
}>()

const crew = computed(() => mineCrew(props.mine))
const ordered = computed(() =>
  historyTabs(
    props.history?.speakers ?? [],
    crew.value.map((dwarf) => dwarf.id)
  )
)

/*
 * The tab the person chose, or null for the first. Kept as an id rather than an index, so a live
 * re-read that reorders the tabs leaves the reader on the dwarf they were reading.
 */
const chosenId = ref<string | null>(null)
const selectedId = computed(() => selectedSpeakerId(ordered.value, chosenId.value))
const selected = computed(() => ordered.value.find((speaker) => speaker.id === selectedId.value))
const rows = computed(() => (selected.value === undefined ? [] : speakerRows(selected.value)))
const marks = computed(() => {
  const byKey = new Map<string, (typeof HISTORY_MARK)[keyof typeof HISTORY_MARK]>()
  historyMarks(rows.value).forEach((mark, i) => {
    if (mark !== undefined) byKey.set(rows.value[i]!.key, HISTORY_MARK[mark])
  })
  return byKey
})
const note = computed(() => historyNote(props.history))
const notice = computed(() => speakerHistoryNotice(selected.value))

/** A dwarf still in the mine wears its state; one that has left it is idle. */
function tabStatus(id: string): PortraitStatus {
  const dwarf = crew.value.find((d) => d.id === id)
  return dwarf === undefined ? 'idle' : sceneDwarfStatus(dwarf)
}

// A tab is a record: nothing in it is still running, so no run says "Working...".
const entries = computed(() => groupActivity(rows.value, { ended: true }))

/*
 * Which bubbles arrive on THIS render (`.dm-bubble.is-new`): a genuine arrival in the tab being
 * read, never a row the reader already saw. By content (`from` + `text`) rather than by key: the
 * fifty-message window re-slices from scratch on every read and every key renames itself once a
 * speaker is past the cap (lib/message/entryArrival.ts names the same blind spot). A tab switch
 * reseeds, so a newly chosen speaker's fifty stay a cut, as on a mount.
 */
const messageIdOf = (row: HistoryRow): string => row.from + '-' + row.text
const idsOf = (list: readonly PanelEntry<HistoryRow>[]): string[] =>
  list.flatMap((entry) => (entry.kind === 'message' ? [messageIdOf(entry.message)] : []))

const seen = new Set<string>(idsOf(entries.value))
let seenFor = selectedId.value
const arrived = ref<ReadonlySet<string>>(new Set())
watch(
  entries,
  (next) => {
    const sameTab = selectedId.value === seenFor
    if (!sameTab) seen.clear()
    const fresh = new Set<string>()
    for (const entry of next) {
      if (entry.kind !== 'message') continue
      const id = messageIdOf(entry.message)
      if (sameTab && !seen.has(id)) fresh.add(entry.key)
      seen.add(id)
    }
    arrived.value = fresh
    seenFor = selectedId.value
  },
  { flush: 'pre' }
)

/*
 * Which runs the reader unfolded, by group key — per run and per mount: a key belongs to one
 * speaker's row, so leaving a tab and coming back finds it as the reader left it.
 */
const openRuns = ref<Record<string, true>>({})
function toggleRun(key: string): void {
  if (openRuns.value[key]) delete openRuns.value[key]
  else openRuns.value[key] = true
}

/*
 * Open on the latest message, on mount and on a tab change only: the transcript runs oldest first,
 * and a live re-read must not pull a reader to the bottom mid-sentence (#192).
 */
const log = ref<HTMLElement | null>(null)
async function showLatest(): Promise<void> {
  await nextTick()
  if (log.value) log.value.scrollTop = log.value.scrollHeight
}
onMounted(showLatest)
watch(selectedId, () => void showLatest())

const tabList = ref<HTMLElement | null>(null)
function choose(id: string): void {
  chosenId.value = id
}

// A tablist's keys: ←/→ to the previous or next tab, wrapping, Home and End to the ends.
async function tabKey(event: KeyboardEvent, index: number): Promise<void> {
  const count = ordered.value.length
  const to =
    event.key === 'ArrowRight'
      ? (index + 1) % count
      : event.key === 'ArrowLeft'
        ? (index - 1 + count) % count
        : event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? count - 1
            : -1
  if (to < 0) return
  event.preventDefault()
  choose(ordered.value[to]!.id)
  await nextTick()
  tabList.value?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus()
}
</script>

<template>
  <section
    class="dm-hist m-mat m-wood m-raised"
    role="dialog"
    :aria-label="historyLabel(mine.name)"
    @keydown.escape="emit('close')"
    @click.stop
  >
    <header class="dm-hist__head">
      <PixelIcon name="history" :scale="2" />
      <h2 class="dm-hist__title">{{ historyTitle(mine.name) }}</h2>
      <ActionButton icon="close" size="sm" title="Close history" @click="emit('close')" />
    </header>
    <div ref="tabList" class="dm-hist__tabs" role="tablist" aria-label="Dwarfs">
      <button
        v-for="(speaker, index) in ordered"
        :key="speaker.id"
        class="dm-hist__tab"
        type="button"
        role="tab"
        :data-id="speaker.id"
        :aria-selected="speaker.id === selectedId ? 'true' : 'false'"
        :tabindex="speaker.id === selectedId ? 0 : -1"
        @click="choose(speaker.id)"
        @keydown="tabKey($event, index)"
      >
        <DwarfPortrait :role="speaker.role" :status="tabStatus(speaker.id)" size="sm" />
        <span>
          <span class="dm-hist__name">{{ speaker.name }}</span>
          <small>{{ historyTabLast(speaker) }}</small>
        </span>
      </button>
    </div>
    <div ref="log" class="dm-hist__log" role="tabpanel">
      <p v-if="note !== null" class="dm-hist__note">{{ note }}</p>
      <template v-else>
        <p class="dm-hist__note" :title="HISTORY_SCOPE_NOTE">{{ HISTORY_READ_ONLY_NOTE }}</p>
        <p v-if="notice !== null" class="dm-hist__note">{{ notice }}</p>
      </template>
      <template v-for="entry in entries" :key="entry.key">
        <div v-if="entry.kind === 'activity'" class="dm-activity">
          <button
            class="dm-activity__toggle"
            type="button"
            :aria-expanded="openRuns[entry.key] ? 'true' : 'false'"
            @click="toggleRun(entry.key)"
          >
            <span class="dm-activity__caret"></span>{{ activityStepsLabel(entry.rows.length) }}
          </button>
          <ul class="dm-activity__list" :hidden="!openRuns[entry.key]">
            <li v-for="line in entry.rows" :key="line.key">
              <button
                v-if="line.activity && isOpenablePath(line.activity)"
                class="dm-activity__path"
                type="button"
                :data-row-key="line.key"
                :title="pathRefusal?.key === line.key ? pathRefusal.reason : line.text"
                @click="emit('open-path', { key: line.key, target: line.activity.target })"
              >
                {{ line.text }}
              </button>
              <template v-else>{{ line.text }}</template>
            </li>
          </ul>
        </div>
        <div
          v-else
          class="dm-bubble m-mat"
          :class="{
            'dm-bubble--user': entry.message.from === 'user',
            'is-new': arrived.has(entry.key)
          }"
          role="article"
          :aria-label="entry.message.from === 'user' ? 'You' : 'Dwarf'"
        >
          <MarkdownBubble
            class="dm-bubble__text"
            :text="entry.message.text"
            @open-link="emit('open-link', $event)"
          />
          <div class="dm-bubble__foot">
            <span v-if="entry.message.time">{{ entry.message.time }}</span>
            <span
              v-if="marks.get(entry.key)"
              class="dm-bubble__mark"
              :data-mark="marks.get(entry.key)!.mark"
              :title="marks.get(entry.key)!.title"
              >{{ marks.get(entry.key)!.glyph }}</span
            >
          </div>
        </div>
      </template>
    </div>
  </section>
</template>

<style scoped>
/* The design's history-panel.css, rule for rule. */
.dm-hist {
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr);
  width: 440px;
  height: 100%;
  min-height: 0;
}
.dm-hist__head {
  display: flex;
  gap: 8px;
  padding: 8px 4px 8px 10px;
  background: var(--wood-lo);
  box-shadow: inset 0 -2px 0 0 var(--rock-lo);
  align-items: center;
}
.dm-hist__title {
  flex: 1;
  min-width: 0;
  font: var(--fs-title) / 1 var(--f-display);
  color: var(--gold);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dm-hist__tabs {
  display: flex;
  gap: 2px;
  padding: 6px 6px 0;
  box-shadow: inset 0 -2px 0 0 var(--wood-lo);
  overflow-x: auto;
}
.dm-hist__tab {
  display: flex;
  min-height: 44px;
  gap: 6px;
  padding: 2px 10px 2px 4px;
  font: var(--fs-meta) / 1.1 var(--f-meta);
  color: var(--ink-soft);
  background: var(--wood-lo);
  box-shadow: inset 2px 2px 0 0 var(--wood-hi);
  align-items: center;
  text-align: left;
  white-space: nowrap;
}
.dm-hist__tab small {
  display: block;
  font-size: 10px;
  color: var(--ink-faint);
}
.dm-hist__tab:hover {
  color: var(--ink);
  box-shadow:
    inset 2px 2px 0 0 var(--wood-hi),
    inset 0 -2px 0 0 var(--brass-lo);
}
.dm-hist__tab[aria-selected='true'] {
  color: var(--parch-hi);
  background: var(--rock);
  box-shadow:
    inset 2px 2px 0 0 var(--wood-hi),
    inset 0 -2px 0 0 var(--brass);
}
.dm-hist__tab .dm-portrait {
  margin: 0;
}
.dm-hist__log {
  display: grid;
  gap: 6px;
  padding: 10px 8px;
  background: var(--rock);
  align-content: start;
  overflow-y: auto;
}
.dm-hist__note {
  font: var(--fs-meta) / 1.3 var(--f-meta);
  color: var(--ink-faint);
  justify-self: center;
}

/* The design's chat-bubble.css, the parts a read-only bubble draws. */
.dm-bubble {
  --mat-fill: var(--parchment);
  --mat-hi: var(--parch-hi);
  --mat-lo: var(--parch-lo);
  --mat-edge: var(--rock-lo);
  display: grid;
  max-width: 92%;
  gap: 6px;
  padding: 8px 10px;
  margin: var(--px);
  font: var(--fs-body) / 1.35 var(--f-talk);
  color: var(--ink-on-light);
  justify-self: start;
  overflow-wrap: anywhere;
}
.dm-bubble--user {
  --mat-fill: var(--parch-lo);
  --mat-hi: var(--parchment);
  --mat-lo: var(--gold-lo);
  max-width: 82%;
  justify-self: end;
}
.dm-bubble :deep(p),
.dm-bubble :deep(ul) {
  margin: 0;
}
.dm-bubble :deep(ul) {
  display: grid;
  gap: 2px;
  padding-left: 14px;
  list-style: none;
}
.dm-bubble :deep(li) {
  position: relative;
}
.dm-bubble :deep(li)::before {
  content: '';
  width: 4px;
  height: 4px;
  position: absolute;
  left: -10px;
  top: 7px;
  background: var(--gold-lo);
}
.dm-bubble :deep(strong) {
  font-weight: 700;
}
.dm-bubble :deep(code) {
  padding: 0 2px;
  font: var(--fs-meta) / 1.3 var(--f-code);
  background: var(--parch-lo);
}
.dm-bubble--user :deep(code) {
  background: var(--parchment);
}
.dm-bubble :deep(pre) {
  margin: 0;
  padding: 6px 8px;
  font: var(--fs-meta) / 1.4 var(--f-code);
  background: var(--parch-lo);
  box-shadow: inset 2px 2px 0 0 var(--gold-lo);
  overflow-x: auto;
}
.dm-bubble :deep(pre code) {
  padding: 0;
  background: none;
}
.dm-bubble__foot {
  display: flex;
  gap: 6px;
  font: var(--fs-meta) / 1 var(--f-meta);
  color: var(--ink-on-light-soft);
  justify-content: flex-end;
}
.dm-bubble__mark[data-mark='reacted'] {
  color: var(--ok-lo);
}
.dm-bubble.is-new {
  animation: dm-pop-in var(--dur-base) var(--ease-out) both;
}

/* The design's activity.css. */
.dm-activity {
  display: grid;
  gap: 2px;
  margin: var(--px);
  justify-self: stretch;
}
.dm-activity__toggle {
  display: flex;
  min-height: var(--hit);
  gap: 6px;
  padding: 0 8px;
  font: var(--fs-meta) / 1 var(--f-meta);
  color: var(--ink-soft);
  background: var(--wood);
  box-shadow: inset 2px 0 0 0 var(--brass-lo);
  align-items: center;
  text-align: left;
}
.dm-activity__toggle:hover {
  color: var(--ink);
  background: var(--wood-hi);
  box-shadow: inset 2px 0 0 0 var(--brass);
}
.dm-activity__caret {
  width: 0;
  height: 0;
  border-left: 5px solid var(--brass);
  border-top: 4px solid transparent;
  border-bottom: 4px solid transparent;
  transition: transform var(--dur-fast) var(--ease-step);
}
.dm-activity__toggle[aria-expanded='true'] .dm-activity__caret {
  transform: rotate(90deg);
}
.dm-activity__list {
  display: grid;
  gap: 2px;
  margin: 0;
  padding: 4px 8px 6px 20px;
  background: var(--wood-lo);
  list-style: none;
  animation: dm-fade-in var(--dur-base) var(--ease-out) both;
}
.dm-activity__list[hidden] {
  display: none;
}
.dm-activity__list li {
  position: relative;
  font: var(--fs-meta) / 1.4 var(--f-meta);
  color: var(--ink-soft);
}
.dm-activity__list li::before {
  content: '';
  width: 4px;
  height: 4px;
  position: absolute;
  left: -10px;
  top: 6px;
  background: var(--ok);
}
.dm-activity__list li:last-child::before {
  background: var(--brass);
}
/*
 * A read or edit step opens its own file (#279): a button styled as the text it is, underlined
 * only for the pointer or the keyboard, so nothing else about the line changes.
 */
.dm-activity__path {
  font: inherit;
  color: inherit;
  text-align: left;
}
.dm-activity__path:hover,
.dm-activity__path:focus-visible {
  text-decoration: underline;
}
@keyframes dm-pop-in {
  from {
    opacity: 0;
    transform: translateY(var(--rise));
  }
  to {
    opacity: 1;
    transform: none;
  }
}
@keyframes dm-fade-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
</style>
