<script setup lang="ts">
/*
 * The Veta window's root (ADR-025 item 1; ISSUE-285): its own renderer of the same bundle, mounted for
 * `?mode=veta`. The window around it is transparent and hugs the island, so the root paints nothing of
 * its own; the strip, its chambers and its entrance arrive with ISSUE-287, and the click-through
 * hit-test (useVetaClickThrough, A-N22) with the island it tests against.
 */
</script>

<template>
  <div class="veta-root" data-veta-root />
</template>

<style scoped>
.veta-root {
  height: 100%;
  background: transparent;
}
</style>
