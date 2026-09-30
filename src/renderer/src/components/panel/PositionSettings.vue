<script setup lang="ts">
import type { PanelEdge } from '../../types'
import ChoiceChip from '../controls/ChoiceChip.vue'
import SegmentedChoice from './SegmentedChoice.vue'
import SettingsRow from './SettingsRow.vue'

/**
 * The Position row of Settings › General (#138, #635, screens/settings.md): the screen edge the
 * docked shell sits on, Right then Left, as the design's segmented chips.
 *
 * Presentational, like ShortcutSettings: `edge` arrives as a prop (main's verdict, read back
 * through usePanelLayout) and every intent leaves as `select`. App.vue owns usePanelLayout.setEdge
 * and therefore the IPC and the persistence, which keeps the "render only what main verified" rule
 * in one place — the same reason a click on the ALREADY-selected chip still emits: this component
 * does not know or decide that the request would be a no-op, and it must not silently swallow it
 * for its owner. The behaviour is today's; only the row is redrawn.
 */
defineProps<{
  edge: PanelEdge
  /** True while a move is in flight; locks both chips (see usePanelLayout.applying). */
  applying: boolean
}>()

const emit = defineEmits<{
  select: [edge: PanelEdge]
}>()
</script>

<template>
  <SettingsRow v-slot="{ labelId }" label="Position" help="The screen edge the panel docks to.">
    <SegmentedChoice :aria-labelledby="labelId">
      <ChoiceChip
        class="position-right"
        label="Right"
        role="radio"
        data-value="Right"
        :pressed="edge === 'right'"
        :disabled="applying"
        @click="emit('select', 'right')"
      />
      <ChoiceChip
        class="position-left"
        label="Left"
        role="radio"
        data-value="Left"
        :pressed="edge === 'left'"
        :disabled="applying"
        @click="emit('select', 'left')"
      />
    </SegmentedChoice>
  </SettingsRow>
</template>
