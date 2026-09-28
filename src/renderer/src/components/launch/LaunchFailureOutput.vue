<script setup lang="ts">
/*
 * The tool's own last lines in the launch-failure notice title's tooltip (#635, MESSAGE-QUESTIONS
 * 23), `.dm-add__fail-out` in the design: its words, not the panel's, so the code face with line
 * breaks kept. What the lines are is lib/launch/launchFailure's.
 */
defineProps<{ text: string }>()
</script>

<template>
  <div class="dm-add__fail-out">{{ text }}</div>
</template>

<style scoped>
/* The design's add-panel.css: a long path breaks anywhere rather than overflowing the card. */
.dm-add__fail-out {
  font: var(--fs-meta) / 1.4 var(--f-code);
  color: var(--ink);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
