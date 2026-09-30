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
import ActivityDisclosure from '../message/ActivityDisclosure.vue'
import ChatBubble from '../message/ChatBubble.vue'
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
import { dwarfDisplayName } from '../../lib/dwarf/displayName'
import type { PortraitStatus } from '../../lib/dwarf/portrait'
import type { FailedSend, Mine, MineHistoryResult } from '../../types'

const props = defineProps<{
  mine: Mine
  /** What main read for this mine. Undefined while the read is in flight, which is its own answer. */
  history?: MineHistoryResult
  /** The refusal main gave for the last path this panel asked it to open (#279), by row key. */
  pathRefusal?: { key: string; reason: string }
  /** The messages the app sent that never arrived, by dwarf id (PANEL-QUESTIONS 16). */
  failed?: Record<string, FailedSend[]>
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
const failedOf = (id: string): FailedSend[] => props.failed?.[id] ?? []
const rows = computed(() =>
  selected.value === undefined ? [] : speakerRows(selected.value, failedOf(selected.value.id))
)
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
 * A run's steps as the disclosure lists them: a read or edit step opens its own path (#279), and
 * a refusal main gave for it stays on its own row, in its title.
 */
function activityLines(rows: readonly HistoryRow[]) {
  return rows.map((line) => ({
    key: line.key,
    text: line.text,
    ...(line.activity && isOpenablePath(line.activity) ? { target: line.activity.target } : {}),
    ...(props.pathRefusal?.key === line.key ? { title: props.pathRefusal.reason } : {})
  }))
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
          <span class="dm-hist__name">{{ dwarfDisplayName(speaker) }}</span>
          <small>{{ historyTabLast(speaker, failedOf(speaker.id)) }}</small>
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
        <ActivityDisclosure
          v-if="entry.kind === 'activity'"
          :label="activityStepsLabel(entry.rows.length)"
          :open="openRuns[entry.key] === true"
          :lines="activityLines(entry.rows)"
          @toggle="toggleRun(entry.key)"
          @open-path="emit('open-path', $event)"
        />
        <ChatBubble
          v-else
          :from="entry.message.from === 'user' ? 'user' : 'agent'"
          :text="entry.message.text"
          :time="entry.message.time"
          :mark="marks.get(entry.key)"
          :is-new="arrived.has(entry.key)"
          @open-link="emit('open-link', $event)"
        />
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
  font-size: var(--fs-small);
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

/*
 * The bubbles and the activity runs are ChatBubble's and ActivityDisclosure's (#635), which carry
 * the design's chat-bubble.css and activity.css with them: they were drawn here until the
 * MessagePanel slice extracted them for both panels.
 */
</style>
