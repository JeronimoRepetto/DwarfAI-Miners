<script setup lang="ts">
/*
 * The needs-you queue, Valle's footer (`organisms/needs-queue`; 07 machine 34; US-VALLE-012; ISSUE-306): one quiet wood
 * strip of a fixed 48 px whose row lists every dwarf waiting on the person, across every mine, oldest first, each entry
 * its "?" (a question) or "!" (a permission), its name and its mine; "Nobody is waiting on you." when nobody waits.
 *
 * - The entries are keyed by dwarf, so a new asker appends at the end and a cleared one closes the gap while the others
 *   neither move nor redraw (AC03, AC04; NFR-PERF-03). Nothing here sorts.
 * - More entries than fit scroll the row sideways; an entry never wraps, shrinks or grows the strip, and the row is never
 *   scrolled to an arrival, so the ones out of view are the newest (AC05).
 * - An entry's accessible name spells out the dwarf and the mine, never the mark alone (AC07).
 */
import { QUEUE_EMPTY_TEXT, QUEUE_LABEL, type EntryView } from '../../lib/valle/needsYou'

defineProps<{ entries: readonly EntryView[] }>()
const emit = defineEmits<{ press: [entry: EntryView] }>()
</script>

<template>
  <footer
    class="dm-vq m-mat"
    :aria-label="QUEUE_LABEL"
    :data-count="entries.length"
    data-needs-queue
  >
    <span class="dm-vq__label" aria-hidden="true">{{ QUEUE_LABEL }}</span>
    <div class="dm-vq__row" role="list">
      <button
        v-for="entry in entries"
        :key="entry.dwarfId"
        type="button"
        class="dm-vq__entry m-mat"
        role="listitem"
        :data-id="entry.dwarfId"
        :data-mine="entry.mineId"
        :aria-label="entry.label"
        @click="emit('press', entry)"
      >
        <span class="dm-vq__mark" aria-hidden="true">{{ entry.mark }}</span>
        <span class="dm-vq__name" aria-hidden="true">{{ entry.name }}</span>
        <span class="dm-vq__where" aria-hidden="true">{{ entry.where }}</span>
      </button>
    </div>
    <span class="dm-vq__empty" :hidden="entries.length > 0">{{ QUEUE_EMPTY_TEXT }}</span>
  </footer>
</template>

<style scoped>
/* `DS` organisms/needs-queue: only the entries are brass, so the eye goes straight to who is waiting. */
.dm-vq {
  --mat-fill: var(--wood-lo);
  --mat-hi: var(--wood);
  --mat-lo: var(--rock-lo);
  display: flex;
  align-items: center;
  gap: 8px;
  height: 48px;
  padding: 0 8px;
  margin: var(--px);
  min-width: 0;
}
.dm-vq__label {
  flex: none;
  font: 400 var(--fs-section) / 1 var(--f-label);
  color: var(--ink-soft);
}
.dm-vq__row {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
  padding: 4px 2px;
}
.dm-vq__empty {
  font: 400 var(--fs-body) / 1 var(--f-meta);
  color: var(--ink-faint);
}
.dm-vq__empty[hidden] {
  display: none;
}
.dm-vq__entry {
  --mat-fill: var(--brass);
  --mat-hi: var(--brass-hi);
  --mat-lo: var(--brass-lo);
  --mat-edge: var(--rock-lo);
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex: none;
  height: 34px;
  margin: var(--px);
  padding: 0 10px 0 4px;
  color: var(--ink-on-light);
  white-space: nowrap;
  transition: transform var(--dur-press) var(--ease-step);
}
.dm-vq__entry:hover {
  --mat-fill: var(--brass-hi);
  --mat-edge: var(--parch-hi);
}
.dm-vq__entry:active {
  transform: translateY(var(--px));
}
.dm-vq__mark {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  font: 400 var(--fs-section) / 1 var(--f-label);
  color: var(--brass);
  background: var(--rock-lo);
}
.dm-vq__name {
  font: 400 var(--fs-section) / 1 var(--f-label);
}
.dm-vq__where {
  font: 400 var(--fs-body) / 1 var(--f-meta);
  color: var(--ink-on-light-soft);
}
</style>
