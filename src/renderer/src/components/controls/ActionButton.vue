<script setup lang="ts">
/*
 * Placeholder for the redesigned button (#635): the atoms slice holds its goldens red first, and
 * builds it in the commit that flips them.
 */
defineProps<{ label?: string }>()
</script>

<template>
  <button type="button">{{ label }}</button>
</template>
