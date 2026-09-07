<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { CLOSE_ICON_SRC, PORTRAIT_SRC, USER_PORTRAIT_SRC, maskImageValue } from '../../lib/art'
import {
  HISTORY_SCOPE_NOTE,
  formatHistoryTimestamp,
  historyNote,
  orderSpeakers,
  selectedSpeakerId,
  speakerHistoryNotice,
  speakerRows
} from '../../lib/history/mineHistory'
import type { Mine, MineHistoryResult } from '../../types'

/**
 * The design's Mine History panel (#192, `screens/history.md`): the floating,
 * read-only surface the mine's History action opens while the mine stays
 * visible — one tab per dwarf that has spoken there, newest first, the latest
 * fifty messages of the selected one, and its last-message time at the lower
 * right. No composer, and nothing else that could send: the maintainer ruled
 * that out in #192, and a mine with no live dwarf has nobody to send to.
 *
 * Thin, like the message panel beside it. Which tab is open, how many rows a
 * tab shows, how the time is spelled and whose face a row wears are all
 * lib/history/mineHistory's; the rows themselves reuse the message panel's
 * surfaces and portrait treatment, which is what the design draws.
 *
 * Mounted per mine (App keys it), so opening it on another mine is a fresh
 * panel and a fresh default tab — the newest — rather than a selection
 * carried over from a folder it does not belong to.
 */

const props = defineProps<{
  mine: Mine
  /** What main read for this mine. Undefined while the read is in flight, which is its own answer. */
  history?: MineHistoryResult
}>()

const emit = defineEmits<{
  close: []
}>()

const ordered = computed(() => orderSpeakers(props.history?.speakers ?? []))

/*
 * The tab the PERSON chose, or null for "whatever the default is". Kept as an
 * id rather than an index so a live re-read that reorders the tabs — a dwarf
 * speaking again moves to the front — leaves the reader on the dwarf they were
 * reading (see selectedSpeakerId).
 */
const chosenId = ref<string | null>(null)
const selectedId = computed(() => selectedSpeakerId(ordered.value, chosenId.value))
const selected = computed(() => ordered.value.find((speaker) => speaker.id === selectedId.value))
const rows = computed(() => (selected.value === undefined ? [] : speakerRows(selected.value)))
const note = computed(() => historyNote(props.history))
/** #227: the selected tab's own admission that it does not reach the conversation's start. */
const notice = computed(() => speakerHistoryNotice(selected.value))
const timestamp = computed(() =>
  selected.value === undefined ? '' : formatHistoryTimestamp(selected.value.lastMessageAt)
)

/*
 * Open on the LATEST message, as the message panel does and for the same
 * reason: the design orders a transcript oldest first, so an unscrolled panel
 * would open on the message furthest from whatever happened last. On mount
 * and on a tab change only — a live re-read must not yank a reader to the
 * bottom mid-sentence. The design leaves scroll anchoring Unspecified; this is
 * the default #192 takes.
 */
const transcriptRef = ref<HTMLElement | null>(null)

async function showLatest(): Promise<void> {
  await nextTick()
  const list = transcriptRef.value
  if (list === null) return
  list.scrollTop = list.scrollHeight
}

onMounted(showLatest)
watch(selectedId, () => void showLatest())

function choose(id: string): void {
  chosenId.value = id
}
</script>

<template>
  <section
    class="history-panel"
    :aria-label="`History of ${mine.name}`"
    @keydown.escape="emit('close')"
    @click.stop
  >
    <!--
      The tab strip: one tab per dwarf, newest first, on the design's amber
      band, with the panel's close at the far end. Overflow scrolls sideways —
      the design leaves tab overflow Unspecified and #192 settles it so.
    -->
    <header class="history-bar">
      <div class="history-tabs" role="tablist" aria-label="Dwarfs that have spoken here">
        <button
          v-for="speaker in ordered"
          :key="speaker.id"
          class="history-tab"
          :class="{ 'is-selected': speaker.id === selectedId }"
          type="button"
          role="tab"
          :aria-selected="speaker.id === selectedId"
          :title="`${speaker.name}, ${speaker.role}`"
          @click="choose(speaker.id)"
        >
          {{ speaker.name }}
        </button>
      </div>
      <button class="history-close" type="button" aria-label="Close history" @click="emit('close')">
        <span
          class="close-glyph"
          :style="{ '--close-icon': maskImageValue(CLOSE_ICON_SRC) }"
          aria-hidden="true"
        ></span>
      </button>
    </header>

    <!--
      #227: an admission the design never asked for, so both the placement —
      top of the tab, fixed above the scroll rather than inside it, since the
      panel opens scrolled to the latest message and a notice buried at the
      scrolled-away top would never be seen — and the copy are this issue's
      own (see HISTORY_TRUNCATED_NOTE). Only the selected speaker's own flag
      decides it, so switching tabs shows or hides it with the tab.
    -->
    <p v-if="notice !== null" class="history-notice">{{ notice }}</p>

    <!--
      The transcript scrolls inside the panel while the tabs and the timestamp
      stay put (#192's reading of "scrollable"). Its accessible name carries
      the one caveat #192 asks the copy to state — the CLIs prune their own
      transcripts — without drawing a line the design does not.
    -->
    <div
      ref="transcriptRef"
      class="history-transcript"
      role="tabpanel"
      tabindex="0"
      :aria-label="HISTORY_SCOPE_NOTE"
    >
      <p v-if="note !== null" class="history-empty">{{ note }}</p>
      <template v-for="row in rows" :key="row.key">
        <!--
          One tool call, same rule as the interactive MessagePanel (#240): a
          muted meta line with no icon, no bubble and no portrait, still one
          row of the tab's own message count.
        -->
        <p v-if="row.activity" class="activity-line" :title="row.text">{{ row.text }}</p>
        <article v-else class="message" :class="row.from === 'agent' ? 'is-agent' : 'is-user'">
          <!--
            The message panel's own portrait treatment (#159), and its own
            reading of whose face this is (#175): a prompt another agent issued
            wears that agent's face, everything else the speaker's own.
          -->
          <img
            v-if="row.from === 'agent'"
            class="portrait"
            :src="PORTRAIT_SRC[row.author.role]"
            :alt="`${row.author.name}, ${row.author.role}`"
            :title="`${row.author.name}, ${row.author.role}`"
            draggable="false"
          />
          <p class="bubble">{{ row.text }}</p>
          <img
            v-if="row.from === 'user'"
            class="portrait"
            :src="USER_PORTRAIT_SRC"
            alt="You"
            draggable="false"
          />
        </article>
      </template>
    </div>

    <!-- The selected dwarf's last-message time, lower right, in the design's format. -->
    <footer class="history-foot">
      <time class="history-timestamp" :title="HISTORY_SCOPE_NOTE">{{ timestamp }}</time>
    </footer>
  </section>
</template>

<style scoped>
/*
 * The design's panel: 500px maximum height, 12px radius, an accent border,
 * #2b2119 and elevation 5 — every one a token. The border's thickness is
 * Unspecified in the source; the message panel's 2px is what a stacked pair of
 * panels should share. The width is Unspecified too, so it takes the message
 * panel's reconciliation (see DwarfMessagePanel): the design's 990 where the
 * composition has it, the composition's where it does not.
 */
.history-panel {
  position: relative;
  z-index: 60;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  width: min(var(--size-message-panel-width), 100%);
  max-height: var(--size-history-panel-max-height);
  border: var(--border-active);
  border-radius: var(--radius-default);
  background: var(--color-panel);
  box-shadow: var(--elevation-5);
  font-size: var(--text-meta);
  text-align: left;
}
/*
 * The amber band the tabs stand on: the design draws every unselected tab in
 * the accent colour and the selected one in the panel's own, so the band IS
 * the unselected surface and a selected tab reads as a notch cut out of it.
 */
.history-bar {
  display: flex;
  flex: none;
  gap: var(--space-nav-gap);
  align-items: flex-end;
  padding: 4px 8px 0;
  background: var(--color-accent);
}
.history-tabs {
  display: flex;
  flex: 1;
  gap: 4px;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
}
/* Unselected: accent background, 10px panel-dark text; 12px top radius. */
.history-tab {
  flex: none;
  padding: 4px 10px;
  border: 0;
  border-radius: var(--radius-default) var(--radius-default) 0 0;
  color: var(--color-panel);
  cursor: pointer;
  background: var(--color-accent);
  font: inherit;
  font-size: var(--text-meta);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  white-space: nowrap;
}
/* Selected: the panel's background and cream text — the notch. */
.history-tab.is-selected {
  color: var(--color-cream);
  background: var(--color-panel);
}
.history-tab:focus-visible {
  outline: 2px solid var(--color-cream);
  outline-offset: -2px;
}
/* The same round close the message panel draws, on the band's far end. */
.history-close {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  margin-bottom: 4px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  cursor: pointer;
  background: var(--color-cream);
}
.close-glyph {
  display: block;
  width: 70%;
  height: 70%;
  background: var(--color-panel);
  mask: var(--close-icon) center / contain no-repeat;
}
.history-close:focus-visible {
  outline: 2px solid var(--color-panel);
  outline-offset: 2px;
}
/*
 * The reached-start admission (#227): fixed above the scrolling transcript,
 * never inside it — the panel opens scrolled to the latest message, and a
 * notice living at the scrolled-away top would defeat its own purpose.
 * Muted like the empty-state line, since it is a caveat rather than content.
 */
.history-notice {
  flex: none;
  margin: 0;
  padding: 6px 8px 0;
  color: var(--color-tooltip-text);
  font-size: var(--text-meta);
  text-align: center;
}
/* The transcript's own scroll, so the tabs and the timestamp stay fixed. */
.history-transcript {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: var(--space-nav-gap);
  overflow-y: auto;
  min-height: 0;
  padding: 8px;
}
.history-empty {
  margin: auto;
  padding: 16px 0;
  color: var(--color-tooltip-text);
  text-align: center;
}
.message {
  display: flex;
  flex: none;
  gap: var(--space-nav-gap);
  align-items: flex-start;
}
.message.is-user {
  justify-content: flex-end;
}
/*
 * One tool-call line (#240), the same rule the interactive MessagePanel draws
 * it with: meta size, muted ink, no bubble, no icon, no portrait — offset by
 * the portrait's width and the row gap so it lines up with the BUBBLE rather
 * than with where a portrait would sit.
 */
.activity-line {
  flex: none;
  margin: 0;
  margin-left: calc(var(--size-portrait) + var(--space-nav-gap));
  overflow: hidden;
  color: var(--color-tooltip-text);
  font-size: var(--text-meta);
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 100px, 12px radius, 2px accent border — the source's own portrait treatment. */
.portrait {
  flex: none;
  width: var(--size-portrait);
  height: var(--size-portrait);
  border: var(--border-active);
  border-radius: var(--radius-default);
  object-fit: cover;
  image-rendering: pixelated;
  user-select: none;
}
/* The message panel's cream surface, both sides; only the alignment differs. */
.bubble {
  margin: 0;
  overflow-wrap: anywhere;
  padding: 8px 10px;
  border: var(--border-active);
  border-radius: var(--radius-default);
  color: var(--color-panel);
  background: var(--color-cream);
  line-height: 1.35;
  white-space: pre-wrap;
  user-select: text;
  -webkit-user-select: text;
}
/* The timestamp: 10px cream, lower right. */
.history-foot {
  flex: none;
  padding: 0 8px 6px;
  text-align: right;
}
.history-timestamp {
  color: var(--color-cream);
  font-size: var(--text-meta);
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
</style>
