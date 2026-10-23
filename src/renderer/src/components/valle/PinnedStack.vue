<script setup lang="ts">
/*
 * The Control room's pinned chat stack (`DS/docs/components.md` organisms/chat-stack; 07 machine 29; US-VALLE-007;
 * ISSUE-302): the head "Pinned chats" with the count of every pin, an open Add panel included, and empty with none
 * (AC12); then one line per pin in order. The pin in focus is expanded, its chat in the `chat` slot; every other pin is
 * one line with its state, "! permission" or "? asking" in brass while its dwarf needs the person (AC06), "gone" once
 * its session ended (AC07). Only one is expanded at a time (AC08).
 *
 * - A closed line is a focusable button: a click, Enter or Space opens it (S29.05); Delete unpins it (S29.10).
 * - × ("Unpin `<name>`") or a middle click unpins any pin; its session keeps running (AC03).
 * - Where keyboard focus goes after an unpin is machine 29's (`focusRequest`): the next line, else the one before it,
 *   else the stack itself (tabindex -1), never dropped (AC04).
 *
 * With nothing pinned the guidance line takes the place of the lines (07 machine 38; US-VALLE-014; ISSUE-310): a pure read
 * of the pins, nothing stored.
 *
 * Presentational: the set, its focus and every decision are the Valle root's (`useVallePins`).
 */
import { computed, nextTick, ref, watch } from 'vue'
import { STACK_EMPTY_TEXT, stackState } from '../../lib/valle/emptyStates'
import type { FocusRequest, PinKey, PinView } from '../../lib/valle/pins'

const props = defineProps<{
  pins: readonly PinView[]
  focus: PinKey | null
  focusRequest: FocusRequest | null
}>()
const emit = defineEmits<{ select: [key: PinKey]; unpin: [key: PinKey] }>()

const root = ref<HTMLElement | null>(null)
/** Machine 38: with nothing pinned the guidance line takes the place of the lines (S38.01). */
const empty = computed(() => stackState({ pins: props.pins }) === 'stack-empty')

watch(
  () => props.focusRequest,
  async (request) => {
    if (request === null) return
    await nextTick()
    const host = root.value
    if (host === null) return
    const target =
      request.target === 'container'
        ? null
        : host.querySelector<HTMLElement>(`[data-pin="${request.target}"]`)
    ;(target ?? host).focus({ preventScroll: true })
  }
)

function onLineKey(event: KeyboardEvent, key: PinKey): void {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    emit('select', key)
  } else if (event.key === 'Delete') {
    event.preventDefault()
    emit('unpin', key)
  }
}

function onAuxClick(event: MouseEvent, key: PinKey): void {
  if (event.button === 1) {
    event.preventDefault()
    emit('unpin', key)
  }
}
</script>

<template>
  <section ref="root" class="dm-cstack" aria-label="Pinned chats" tabindex="-1">
    <header class="dm-cstack__head m-mat">
      <span class="dm-cstack__title">Pinned chats</span>
      <span class="dm-cstack__count">{{ pins.length > 0 ? pins.length : '' }}</span>
    </header>
    <div class="dm-cstack__list">
      <template v-for="pin in pins" :key="pin.key">
        <div
          v-if="pin.key === focus"
          class="dm-cstack__open"
          tabindex="-1"
          data-expanded="true"
          :data-pin="pin.key"
          :data-pin-mine="pin.mineId"
          :data-pin-state="pin.state"
          :data-read-only="pin.readOnly ? 'true' : 'false'"
          :aria-label="pin.text.name"
          @auxclick="onAuxClick($event, pin.key)"
        >
          <div class="dm-cstack__row m-mat" :data-needs="pin.text.needs ? 'true' : 'false'">
            <span class="dm-cstack__name">{{ pin.text.name }}</span>
            <span class="dm-cstack__state">{{ pin.text.line }}</span>
            <button
              type="button"
              class="dm-cstack__x"
              :aria-label="pin.text.unpinLabel"
              title="Unpin"
              @click.stop="emit('unpin', pin.key)"
            >
              <span aria-hidden="true">×</span>
            </button>
          </div>
          <slot name="chat" :pin="pin" />
        </div>
        <div
          v-else
          class="dm-cstack__row m-mat"
          role="button"
          tabindex="0"
          data-expanded="false"
          :data-pin="pin.key"
          :data-pin-mine="pin.mineId"
          :data-pin-state="pin.state"
          :data-needs="pin.text.needs ? 'true' : 'false'"
          :aria-label="pin.text.lineLabel"
          @click="emit('select', pin.key)"
          @keydown="onLineKey($event, pin.key)"
          @auxclick="onAuxClick($event, pin.key)"
        >
          <span class="dm-cstack__name">{{ pin.text.name }}</span>
          <span class="dm-cstack__state">{{ pin.text.line }}</span>
          <button
            type="button"
            class="dm-cstack__x"
            tabindex="-1"
            :aria-label="pin.text.unpinLabel"
            title="Unpin"
            @click.stop="emit('unpin', pin.key)"
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
      </template>
    </div>
    <p v-if="empty" class="dm-cstack__empty">{{ STACK_EMPTY_TEXT }}</p>
  </section>
</template>

<style scoped>
/* `DS/docs/components.md` organisms/chat-stack, Geometry. */
.dm-cstack {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  gap: 4px;
  min-width: 0;
  min-height: 0;
  height: 100%;
}
.dm-cstack__head {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 44px;
  padding: 0 10px;
  margin: var(--px, 2px);
  --mat-fill: var(--wood);
}
.dm-cstack__title {
  font-family: var(--f-display);
  font-size: var(--fs-title, 21px);
  line-height: 1;
  color: var(--gold);
}
.dm-cstack__count {
  font-family: var(--f-meta);
  font-size: var(--fs-meta, 12px);
  line-height: 1;
  color: var(--ink-faint);
}
.dm-cstack__list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-height: 0;
}
.dm-cstack__empty {
  padding: 12px;
  font-family: var(--f-meta);
  font-size: var(--fs-body, 14px);
  line-height: 1.4;
  color: var(--ink-faint);
}
.dm-cstack__open {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-height: 240px;
}
/*
 * The MessagePanel or the Add panel in the chat zone fills it and shrinks with it down to its own min-content width
 * (decision log, MessagePanel width; 07 S33.11): only its root is sized here, so every part inside keeps its own size,
 * and its floor sits on the panel, never on the host, so Valle's minimums do not move for it (US-MSG-015.AC06).
 */
.dm-cstack__open > :deep(.dm-msg),
.dm-cstack__open > :deep(.dm-add) {
  flex: 1 1 auto;
  width: 100%;
  min-width: min-content;
}
.dm-cstack__row {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
  height: 44px;
  margin: var(--px, 2px);
  padding: 0 2px 0 4px;
  cursor: pointer;
  color: var(--ink-soft);
  --mat-fill: var(--wood-lo);
  --mat-hi: var(--wood);
  --mat-lo: var(--rock-lo);
}
.dm-cstack__row:hover {
  color: var(--ink);
  --mat-edge: var(--brass-lo);
}
.dm-cstack__row[data-needs='true'] {
  --mat-edge: var(--brass);
}
.dm-cstack__name {
  font-family: var(--f-meta);
  font-size: var(--fs-body, 14px);
  line-height: 1;
  white-space: nowrap;
  color: var(--parchment);
}
.dm-cstack__state {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-family: var(--f-meta);
  font-size: var(--fs-meta, 12px);
  line-height: 1;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--ink-faint);
}
.dm-cstack__row[data-needs='true'] .dm-cstack__state {
  color: var(--brass);
}
.dm-cstack__x {
  display: grid;
  flex: none;
  place-items: center;
  width: 32px;
  height: 32px;
  opacity: 0.55;
}
.dm-cstack__x:hover {
  background: var(--rock-lo);
  opacity: 1;
}
</style>
