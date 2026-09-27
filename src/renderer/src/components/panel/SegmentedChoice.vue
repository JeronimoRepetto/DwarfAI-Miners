<script setup lang="ts">
/*
 * A row of choice chips of which one is in force (#635), the design's `.dm-seg` in
 * organisms/settings: a radiogroup whose chips each keep their own bevel, 8px apart, wrapping when
 * they do not fit (PO feedback: options sat touching each other). The chips are the caller's, as
 * ChoiceChip with role radio; this only groups and spaces them.
 */
</script>

<template>
  <div class="dm-seg" role="radiogroup"><slot /></div>
</template>

<style scoped>
/* The design's settings.css `.dm-seg`, rule for rule. */
.dm-seg {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 8px;
}
.dm-seg :slotted(.dm-chip) {
  margin: 2px 0;
}
</style>
