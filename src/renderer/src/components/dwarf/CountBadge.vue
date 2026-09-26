<script setup lang="ts">
/*
 * The redesigned badge (#635), `DM.ui.badge` in the design: a brass or danger plate with a
 * tabular count, on a corner. Hidden from assistive tech: the control it sits on carries the
 * count in its own name ("Mines, 2 need you"). What it shows is lib/dwarf/badge's.
 */
import { computed } from 'vue'
import { badgeClasses, badgeText, type BadgeTone } from '../../lib/dwarf/badge'

const props = defineProps<{ count: number; tone?: BadgeTone }>()

const classes = computed(() => badgeClasses(props.tone))
</script>

<template>
  <span :class="classes" aria-hidden="true">{{ badgeText(count) }}</span>
</template>

<style scoped src="./badge.css"></style>
