<script setup lang="ts">
/*
 * Placeholder for the redesign's icon atom (#635): its goldens are held red first, and the commit
 * that flips them builds it.
 */
defineProps<{ name: string; scale?: 1 | 2; tone?: 'danger' | 'dim' | 'ok' }>()
</script>

<template>
  <span aria-hidden="true" />
</template>
