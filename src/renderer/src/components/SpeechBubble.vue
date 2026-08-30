<script setup lang="ts">
/**
 * The truncated in-cave bubble. Its text sits inside a real <button> so the
 * full message is one click — or Enter, native button activation — away
 * (see #26); the chrome is stripped below so the bubble looks exactly as it
 * did before it became clickable. `.stop` keeps the click from bubbling to
 * the document-level close handlers: expanding a bubble must never toggle
 * the dwarf's own action menu.
 */
defineProps<{
  text: string
  /** Accessible name for the expand control, e.g. "Read the full message from Gimli". */
  expandLabel: string
  /** Mirrored onto aria-expanded so assistive tech tracks the panel state. */
  expanded: boolean
}>()

const emit = defineEmits<{ expand: [] }>()
</script>

<template>
  <div class="speech-bubble" role="status">
    <button
      class="bubble-hit"
      type="button"
      :aria-label="expandLabel"
      :aria-expanded="expanded"
      @click.stop="emit('expand')"
    >
      <span class="bubble-text">{{ text }}</span>
    </button>
  </div>
</template>

<style scoped>
.speech-bubble {
  position: relative;
  max-width: 150px;
  padding: 6px 9px;
  border: 1px solid var(--parchment-line);
  border-radius: 10px;
  color: var(--parchment-ink);
  background: var(--parchment);
  font-size: 10px;
  line-height: 1.35;
  text-align: left;
  animation: bubble-in 0.22s ease-out;
}
.speech-bubble::after {
  position: absolute;
  bottom: -6px;
  left: 16px;
  content: '';
  border: 6px solid transparent;
  border-top-color: var(--parchment);
  border-bottom: 0;
}
/* Strip the button chrome: the clickable bubble must look exactly like the plain one did. */
.bubble-hit {
  display: block;
  width: 100%;
  padding: 0;
  border: 0;
  color: inherit;
  cursor: pointer;
  background: transparent;
  font: inherit;
  text-align: inherit;
}
.bubble-hit:focus-visible {
  outline: 2px solid #ffe29c;
  outline-offset: 2px;
  border-radius: 6px;
}
.bubble-text {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  line-clamp: 3;
}
@keyframes bubble-in {
  from {
    opacity: 0;
    transform: translateY(4px) scale(0.94);
  }
}
</style>
