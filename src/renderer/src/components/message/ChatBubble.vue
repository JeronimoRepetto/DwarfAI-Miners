<script setup lang="ts">
/*
 * One chat bubble (#635), `molecules/chat-bubble` in the design: parchment for the dwarf, parchment
 * low for you, a Markdown body in the talk face, the time and, for your messages, the delivery
 * mark. Anything under the foot — a failed message's actions, the files it was sent with — is the
 * host's, in the default slot. Shared by the MessagePanel and the mine history, whose markup it
 * was until this slice extracted it. Which mark a bubble wears is its host's to decide
 * (lib/message/panelChrome, lib/history/mineHistory); this draws it.
 */
import MarkdownBubble from './MarkdownBubble.vue'

defineProps<{
  /** Who said it: the person's own words sit at the end, the dwarf's at the start. */
  from: 'user' | 'agent'
  text: string
  /** "HH:MM", or nothing where the transcript gave no time. */
  time?: string
  /** The delivery mark, on the person's own messages only. */
  mark?: { mark: string; glyph: string; title: string }
  /** A genuine arrival on this render: it pops in (motion.md, `.dm-bubble.is-new`). */
  isNew?: boolean
}>()

const emit = defineEmits<{
  /** A link in the body was pressed; the host relays it to main, which opens it (#347). */
  'open-link': [href: string]
}>()
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
      <span v-if="mark" class="dm-bubble__mark" :data-mark="mark.mark" :title="mark.title">{{
        mark.glyph
      }}</span>
    </div>
    <slot />
  </div>
</template>

<style scoped>
/*
 * The body is MarkdownBubble's tree, whose own rules are its own: here the design's
 * chat-bubble.css draws it, so its blocks stack with no gap of their own and its code keeps the
 * square corners every surface has (foundations, Stepped pixel corners). Written one class deeper
 * than MarkdownBubble's rules so they win whatever order the two sheets load in.
 */
.dm-bubble .dm-bubble__text {
  display: block;
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
.dm-bubble :deep(.dm-bubble__actions) {
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
</style>
