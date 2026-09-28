<script setup lang="ts">
/*
 * One chat bubble (#635), `molecules/chat-bubble` in the design: parchment for the dwarf, parchment
 * low for you, a Markdown body in the talk face, the time and, for your messages, the delivery
 * mark. The files a message was sent with are the host's, in the default slot. Shared by the
 * MessagePanel and the mine history, whose markup it was until this slice extracted it. Which mark
 * a bubble wears is its host's to decide (lib/message/panelChrome, lib/history/mineHistory); this
 * draws it.
 *
 * A failed message's way out is the bubble's own (decision log, Failed delivery): while its mark
 * is ✕ and its host offers a retry, Retry and Copy sit under the foot, and they go as soon as the
 * mark leaves ✕. Nothing retries on its own: the bubble reports the press and its host re-sends
 * the same message, walking this same bubble's mark. On a session that can no longer take text
 * Copy stands alone (decision log, Copy alone on a closed session): Retry is absent rather than
 * disabled, since nothing will ever make it work there, and Copy never hides, because it is the
 * one action that still helps.
 */
import {
  COPY_LABEL,
  COPY_TITLE,
  RETRY_LABEL,
  RETRY_TITLE
} from '../../lib/delivery/deliveryVerdict'
import { computed } from 'vue'
import { useHoverTip } from '../../composables/useHoverTip'
import ActionButton from '../controls/ActionButton.vue'
import TooltipCard from '../overlay/TooltipCard.vue'
import MarkdownBubble from './MarkdownBubble.vue'

const props = defineProps<{
  /** Who said it: the person's own words sit at the end, the dwarf's at the start. */
  from: 'user' | 'agent'
  text: string
  /** "HH:MM", or nothing where the transcript gave no time. */
  time?: string
  /** The delivery mark, on the person's own messages only. */
  mark?: { mark: string; glyph: string; title: string }
  /** A genuine arrival on this render: it pops in (motion.md, `.dm-bubble.is-new`). */
  isNew?: boolean
  /**
   * Whether the host can re-send this message: the design's `onRetry`. Retry and Copy show only
   * while it is set and the mark is ✕; the read-only history never sets it.
   */
  offersRetry?: boolean
  /**
   * The session behind the message can no longer take text (it ended, or its delivery route went
   * away): the design's `sessionClosed`. While the mark is ✕ the group shows Copy alone, and it
   * wins over `offersRetry`, as the design's does. The read-only history never sets it either.
   */
  sessionClosed?: boolean
  /**
   * Why a failed mark failed, in main's own words: a refused "Answers:" record's reason (#635,
   * MESSAGE-QUESTIONS 21; components.md, Chat bubble, "A refusal's reason"). While the mark is ✕
   * it is the mark's tooltip, never an alert and never a line in the bubble.
   */
  reason?: string
}>()

const emit = defineEmits<{
  /** A link in the body was pressed; the host relays it to main, which opens it (#347). */
  'open-link': [href: string]
  /** Retry was pressed: the host re-sends the same message in place. */
  retry: []
  /** Copy was pressed: the host puts the text on the clipboard and says so. */
  copy: []
}>()

/*
 * The ✕ mark carrying a refusal's reason (components.md, Chat bubble, "A refusal's reason"): its
 * tooltip above the mark and aligned to its end, on hover after the tooltip delay and at once on
 * keyboard focus, as every tooltip shows (useHoverTip). While it carries one the mark takes
 * keyboard focus, is described by a hidden copy of the reason, and has no native title; the
 * reason goes once the mark leaves ✕, and a ✕ without one keeps its plain title.
 */
const reasonShown = computed(
  () => props.mark?.mark === 'failed' && props.reason !== undefined && props.reason !== ''
)
const reasonTip = useHoverTip<'reason'>({ side: 'top', align: 'end' })
const reasonId = 'dm-bubble-reason-' + ++bubbles
</script>

<script lang="ts">
/** Every bubble's own number, for the id its reason's hidden copy is named by. */
let bubbles = 0
</script>

<template>
  <div
    class="dm-bubble m-mat"
    :class="{ 'dm-bubble--user': from === 'user', 'is-new': isNew }"
    role="article"
    :aria-label="from === 'user' ? 'You' : 'Dwarf'"
  >
    <MarkdownBubble class="dm-bubble__text" :text="text" @open-link="emit('open-link', $event)" />
    <div class="dm-bubble__foot">
      <span v-if="time">{{ time }}</span>
      <span
        v-if="mark"
        class="dm-bubble__mark"
        :data-mark="mark.mark"
        :title="reasonShown ? undefined : mark.title"
        :tabindex="reasonShown ? 0 : undefined"
        :aria-describedby="reasonShown ? reasonId : undefined"
        @pointerenter="reasonShown && reasonTip.hover('reason', $event)"
        @pointerleave="reasonTip.leave"
        @pointerdown="reasonTip.press"
        @focus="reasonShown && reasonTip.focus('reason', $event)"
        @blur="reasonTip.hide"
        >{{ mark.glyph }}</span
      >
      <span v-if="reasonShown" :id="reasonId" class="sr-only">{{ reason }}</span>
    </div>
    <!-- In <body>: a bubble sits inside a scrolling log, which would otherwise clip a fixed card. -->
    <Teleport to="body">
      <Transition name="dm-tip-pop">
        <TooltipCard
          v-if="reasonShown && reasonTip.shown.value !== null"
          :ref="reasonTip.card"
          :style="reasonTip.style.value"
          ><div>{{ reason }}</div></TooltipCard
        >
      </Transition>
    </Teleport>
    <slot />
    <div
      v-if="(offersRetry || sessionClosed) && mark?.mark === 'failed'"
      class="dm-bubble__actions"
      role="group"
      aria-label="Not delivered"
    >
      <ActionButton
        v-if="!sessionClosed"
        :label="RETRY_LABEL"
        size="sm"
        :title="RETRY_TITLE"
        @click="emit('retry')"
      />
      <ActionButton :label="COPY_LABEL" size="sm" :title="COPY_TITLE" @click="emit('copy')" />
    </div>
  </div>
</template>

<style scoped>
/*
 * The body is MarkdownBubble's tree, whose own rules are its own: here the design's
 * chat-bubble.css draws it, so its blocks stack with no gap of their own and its code keeps the
 * square corners every surface has (foundations, Stepped pixel corners). Written one class deeper
 * than MarkdownBubble's rules so they win whatever order the two sheets load in.
 */
/*
 * The words are the one part of the panel a person selects (#635, PO request 2026-09-28): a press
 * and drag picks text to copy out of a conversation, where `body` makes the rest of the panel a
 * desktop control. Only the body: the foot's time and mark and the Retry and Copy buttons stay
 * controls, so a drag across bubbles copies what was said, not their chrome.
 */
.dm-bubble .dm-bubble__text {
  display: block;
  user-select: text;
  -webkit-user-select: text;
}
.dm-bubble .dm-bubble__text :deep(.markdown-list) {
  margin: 0;
  padding-left: 14px;
}
.dm-bubble .dm-bubble__text :deep(.markdown-code),
.dm-bubble .dm-bubble__text :deep(.markdown-block-code) {
  border-radius: 0;
}
.dm-bubble .dm-bubble__text :deep(.markdown-block-code) {
  line-height: 1.4;
}

/* The design's chat-bubble.css, rule for rule. */
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
.dm-bubble__mark[data-mark='failed'] {
  color: var(--danger-ink);
}
.dm-bubble__actions {
  display: flex;
  gap: var(--sp-2);
  justify-content: flex-end;
}
.dm-bubble.is-new {
  animation: dm-pop-in var(--dur-base) var(--ease-out) both;
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

/* The tooltip's entrance (motion.md, `dm-tip-pop`), as every tooltip owner writes it. */
.dm-tip-pop-enter-active {
  transition:
    transform var(--dur-base) var(--ease-out),
    opacity var(--dur-base) var(--ease-out);
}
.dm-tip-pop-leave-active {
  transition: opacity var(--dur-fast) var(--ease-in);
}
.dm-tip-pop-enter-from {
  opacity: 0;
  transform: translateY(var(--tip-rise));
}
.dm-tip-pop-leave-to {
  opacity: 0;
}
</style>
