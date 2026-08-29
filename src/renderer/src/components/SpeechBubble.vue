<script setup lang="ts">
defineProps<{ text: string }>()
</script>

<template>
  <div class="speech-bubble" role="status">
    <span class="bubble-text">{{ text }}</span>
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
