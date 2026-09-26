<script setup lang="ts">
/*
 * The help line under a field (#635), `.dm-field__hint` in the design's input.css: small text in
 * faint ink, danger ink when it reports why the field is invalid ("Invalid adds a danger edge and
 * help text"). A sibling of the field rather than a part of it, as the design draws it: the
 * input's own options have no hint. Its id falls through to the line, and is what an invalid
 * input's `describedBy` names.
 */
withDefaults(defineProps<{ error?: boolean }>(), { error: false })
</script>

<template>
  <p :class="['dm-field__hint', ...(error ? ['is-error'] : [])]"><slot /></p>
</template>

<style scoped>
.dm-field__hint {
  margin: 4px 2px 0;
  font: var(--fs-meta) / 1.3 var(--f-meta);
  color: var(--ink-faint);
}
.dm-field__hint.is-error {
  color: var(--danger-hi);
}
</style>
