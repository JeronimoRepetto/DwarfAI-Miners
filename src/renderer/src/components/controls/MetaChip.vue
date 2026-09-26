<script setup lang="ts">
/*
 * The redesigned meta chip (#635), `DM.ui.metaChip` in the design: a sunken header fact, not
 * pressable. A fact too long for its header is cut with an ellipsis, so its tooltip carries it
 * whole: the fact itself unless a title is given.
 */
import { computed } from 'vue'
import { metaChipTitle } from '../../lib/controls/chip'

const props = defineProps<{ text: string; title?: string }>()

const tooltip = computed(() => metaChipTitle(props.text, props.title))
</script>

<template>
  <span class="dm-meta" :title="tooltip">{{ text }}</span>
</template>

<style scoped src="./chip.css"></style>
