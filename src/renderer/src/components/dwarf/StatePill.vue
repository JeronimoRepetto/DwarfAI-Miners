<script setup lang="ts">
/*
 * The redesigned pill (#635), `DM.ui.pill` in the design: an optional icon or needs-you plate
 * ("?" a question, "!" a permission), then the state word, in its tone. Plain text that reads as
 * it shows, and never a button.
 */
import { computed } from 'vue'
import PixelIcon from '../icon/PixelIcon.vue'
import { pillClasses, type PillTone } from '../../lib/dwarf/badge'
import type { IconName } from '../../lib/icon/iconGrids'

const props = withDefaults(
  defineProps<{ text: string; tone?: PillTone; icon?: IconName; ask?: boolean; mark?: string }>(),
  { tone: undefined, icon: undefined, ask: false, mark: '?' }
)

const classes = computed(() => pillClasses(props.tone))
</script>

<template>
  <span :class="classes"
    ><PixelIcon v-if="icon !== undefined" :name="icon" /><span v-if="ask" class="dm-pill__q">{{
      mark
    }}</span
    >{{ text }}</span
  >
</template>

<style scoped src="./badge.css"></style>
