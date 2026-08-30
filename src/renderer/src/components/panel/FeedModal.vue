<script setup lang="ts">
import { truncate } from '../../../../shared/truncate'
import type { FeedMessage } from '../../types'

defineProps<{
  title: string
  messages: FeedMessage[]
}>()

const emit = defineEmits<{ close: [] }>()
</script>

<template>
  <div class="feed-overlay" @click.self="emit('close')">
    <div class="feed-board" role="dialog" aria-modal="true" :aria-label="`Activity of ${title}`">
      <header class="feed-header">
        <h2>{{ title }}'s notes</h2>
        <button class="feed-close" type="button" aria-label="Close" @click="emit('close')">
          &times;
        </button>
      </header>
      <p class="feed-hint">The terminal could not be focused — latest activity instead:</p>
      <ul class="feed-list">
        <li v-for="(message, index) in messages" :key="message.timestamp + index">
          <strong>{{ message.role === 'assistant' ? 'Agent' : 'Request' }}</strong>
          <span>{{ truncate(message.text, 180) }}</span>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.feed-overlay {
  position: absolute;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: #0b0805cc;
}
.feed-board {
  display: flex;
  flex-direction: column;
  width: min(340px, 100%);
  max-height: 80%;
  padding: 14px 16px;
  border: 1px solid var(--parchment-line);
  border-radius: 10px;
  color: var(--parchment-ink);
  background: linear-gradient(#0000, #00000014), var(--parchment);
  box-shadow: 0 10px 34px #000c;
  animation: board-in 0.18s ease-out;
}
.feed-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.feed-header h2 {
  overflow: hidden;
  margin: 0;
  font-size: 15px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.feed-close {
  padding: 0 6px;
  border: 0;
  border-radius: 6px;
  color: var(--parchment-ink);
  cursor: pointer;
  background: transparent;
  font-size: 20px;
}
.feed-close:hover {
  background: #00000018;
}
.feed-close:focus-visible {
  outline: 2px solid #7c5a2c;
  outline-offset: 2px;
}
.feed-hint {
  margin: 6px 0 10px;
  font-size: 11px;
  opacity: 0.75;
}
.feed-list {
  overflow: auto;
  margin: 0;
  padding: 0;
  list-style: none;
}
.feed-list li {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 0;
  border-top: 1px dashed #7c5a2c66;
  font-size: 12px;
  line-height: 1.45;
}
.feed-list strong {
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
@keyframes board-in {
  from {
    opacity: 0;
    transform: translateY(8px) scale(0.97);
  }
}
</style>
