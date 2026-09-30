<script setup lang="ts">
/*
 * The composer (#635), `molecules/composer` in the design (screens/message.md, W4·4–5): the
 * attached-file pills, Attach on the left, the writing well, Send as the one primary button on the
 * right, and the hint under them. Extracted from the MessagePanel so the panel and the design's own
 * state draw one source.
 *
 * Thin: what may be sent, what the hint says, what a dropped file becomes and whether the well
 * takes text are all the host's (lib/delivery/*, the panel). This reports the person's acts:
 * typing, Enter, a press on Attach, Send or a pill's remove, and a drop. Enter sends and
 * Shift+Enter breaks the line; an input method's own Enter picks its candidate and sends nothing,
 * because the text is not written yet (belongsToComposition).
 *
 * Dropping files anywhere on it attaches them (#408); `preventDefault` on both dragover and drop is
 * the whole of the navigation guard — a file dropped on a page the browser may navigate REPLACES
 * that page. A drag over it lights the well's edge, and nothing else moves.
 */
import { ref } from 'vue'
import { belongsToComposition } from '../../lib/controls/input'
import ActionButton from '../controls/ActionButton.vue'
import InputField from '../controls/InputField.vue'
import PixelIcon from '../icon/PixelIcon.vue'

defineProps<{
  value: string
  placeholder: string
  /** The well takes no text: the session cannot receive, and `title` says why. */
  disabled?: boolean
  /** The well's tooltip. */
  title?: string
  /** Whether Attach is live, and what it says either way. */
  canAttach?: boolean
  attachTitle?: string
  /** Whether Send is live: something to send, and somewhere to send it. */
  canSend?: boolean
  /** The files waiting to go with the next message. */
  files?: readonly { path: string; name: string }[]
  /** The hint line, and whether it speaks for a refusal (an alert) or a status. */
  hint: string
  hintRole?: 'alert' | 'status'
}>()

const emit = defineEmits<{
  'update:value': [value: string]
  /** Enter without Shift, outside a composition, or a press on Send. */
  submit: []
  attach: []
  /** A pending file's remove button, by its path. */
  remove: [path: string]
  drop: [event: DragEvent]
}>()

const dragging = ref(false)

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || event.shiftKey) return
  if (belongsToComposition(event)) return
  event.preventDefault()
  emit('submit')
}

function onDrop(event: DragEvent): void {
  dragging.value = false
  emit('drop', event)
}
</script>

<template>
  <div
    class="dm-composer"
    :class="{ 'is-dragging': dragging }"
    @dragover.prevent="dragging = true"
    @dragleave="dragging = false"
    @drop.prevent="onDrop"
  >
    <div class="dm-composer__files">
      <span v-for="item in files" :key="item.path" class="dm-composer__file" :title="item.name">
        <PixelIcon name="attach" />
        <span>{{ item.name }}</span>
        <button
          type="button"
          :aria-label="`Remove ${item.name}`"
          @click="emit('remove', item.path)"
        >
          <PixelIcon name="close" />
        </button>
      </span>
    </div>
    <div class="dm-composer__row">
      <ActionButton
        class="dm-composer__attach"
        icon="attach"
        :title="attachTitle ?? 'Attach a file'"
        :disabled="!canAttach"
        @click="emit('attach')"
      />
      <InputField
        area
        :rows="2"
        :placeholder="placeholder"
        label="Message"
        :value="value"
        :disabled="disabled"
        :title="title"
        @update:value="emit('update:value', $event)"
        @keydown="onKeydown"
      />
      <ActionButton
        class="dm-composer__send"
        variant="primary"
        icon="send"
        label="Send"
        :disabled="!canSend"
        @click="emit('submit')"
      />
    </div>
    <p class="dm-composer__hint" :class="{ 'is-error': hintRole === 'alert' }" :role="hintRole">
      {{ hint }}
    </p>
  </div>
</template>

<style scoped>
/* The design's composer.css. */
.dm-composer {
  display: grid;
  gap: 4px;
  padding: 6px 6px 4px;
}
.dm-composer__row {
  display: flex;
  gap: 4px;
  align-items: flex-end;
}
/* The writing well is what gives way in a narrow window: Attach and Send keep their size. */
.dm-composer__row :deep(.dm-field) {
  flex: 1;
  min-width: 0;
}
.dm-composer__row :deep(.dm-field textarea) {
  width: 0;
  max-height: 120px;
}
.dm-composer__row :deep(.dm-btn) {
  flex: none;
}
.dm-composer__row :deep(.dm-composer__send) {
  min-height: var(--hit-nav);
}
.dm-composer__hint {
  margin: 0;
  padding: 0 4px;
  font: var(--fs-meta) / 1.2 var(--f-meta);
  color: var(--ink-faint);
}
/* The hint speaking for a refusal, in the error colour the field hints use (atoms/input). */
.dm-composer__hint.is-error {
  color: var(--danger-hi);
}
.dm-composer__files {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
/* A file waiting to go, as the design's pill (`DM.ui.pill` with the attach icon). */
.dm-composer__file {
  display: inline-flex;
  gap: 4px;
  padding: 0 0 0 6px;
  font: var(--fs-meta) / 20px var(--f-meta);
  color: var(--ink-soft);
  background: var(--rock-lo);
  align-items: center;
}
.dm-composer__file button {
  width: 24px;
  height: 20px;
  display: grid;
  place-items: center;
}
.dm-composer.is-dragging :deep(.dm-field) {
  --mat-edge: var(--brass);
}
</style>
