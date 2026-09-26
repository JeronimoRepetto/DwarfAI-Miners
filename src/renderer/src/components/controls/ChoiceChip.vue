<script setup lang="ts">
/*
 * The redesigned choice chip (#635), `atoms/chip` in the design: a control-wood button that
 * toggles gold with aria-pressed, or is a radio with aria-checked inside a radiogroup, with an
 * optional tier gem before its label. What the options decide is in lib/controls/chip; this only
 * draws it. A click falls through to the native button, which a disabled one never fires.
 */
import { computed } from 'vue'
import PixelIcon from '../icon/PixelIcon.vue'
import { chipAttributes, chipClasses, type ChipOptions } from '../../lib/controls/chip'

// `pressed` defaults to undefined, not false: only a chip that toggles states it at all.
const props = withDefaults(defineProps<ChipOptions>(), { pressed: undefined, disabled: false })

const classes = computed(() => chipClasses(props))
const attributes = computed(() => chipAttributes(props))
</script>

<template>
  <button :class="classes" v-bind="attributes">
    <span v-if="tier !== undefined" class="dm-gem"></span>
    <PixelIcon v-if="icon !== undefined" :name="icon" />{{ label }}
  </button>
</template>

<style scoped src="./chip.css"></style>
