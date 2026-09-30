<script setup lang="ts">
/*
 * The redesigned tier chip (#635), `DM.ui.tierChip` in the design: the tier word on its -lo
 * ground in the marker colour, with its gem. The word is the redesign's tier label, so Copper is
 * spelled as the maintainer ruled (#165), and a tier is never conveyed by colour alone.
 */
import { computed } from 'vue'
import { designTierLabel } from '../../lib/presentation'
import type { MineTier } from '../../types'

const props = defineProps<{ tier: MineTier }>()

const label = computed(() => designTierLabel(props.tier))
</script>

<template>
  <span class="dm-tier" :data-tier="tier"><span class="dm-gem"></span>{{ label }}</span>
</template>

<style scoped src="./chip.css"></style>
