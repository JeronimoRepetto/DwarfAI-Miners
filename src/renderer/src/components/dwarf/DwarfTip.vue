<script setup lang="ts">
/*
 * The dwarf tooltip's body (#635), `molecules/dwarf-tooltip` in the design: the dwarf's face, then
 * its name, rank and provider, model and effort, silence and status, inside the shared tooltip
 * card; under a custom name, the base name on a line of its own (#635). Shared by the sprite and its roster portrait, so both always say the same thing; it has no
 * controls. The words are lib/dwarf/dwarfTip's. Replaces DwarfTooltip.vue.
 */
import { computed } from 'vue'
import DwarfPortrait from './DwarfPortrait.vue'
import { dwarfTip } from '../../lib/dwarf/dwarfTip'
import type { Dwarf } from '../../types'

const props = defineProps<{ dwarf: Dwarf }>()

const tip = computed(() => dwarfTip(props.dwarf))
</script>

<template>
  <div class="dm-dtip">
    <DwarfPortrait :role="dwarf.role" :status="tip.status" size="sm" />
    <div class="dm-dtip__lines">
      <div class="dm-dtip__name">{{ tip.name }}</div>
      <div v-if="tip.baseName !== undefined" class="dm-dtip__base">{{ tip.baseName }}</div>
      <div class="dm-dtip__line">
        {{ tip.rank }} · <b>{{ tip.provider }}</b>
      </div>
      <div class="dm-dtip__line">{{ tip.tuning }}</div>
      <div class="dm-dtip__line">
        {{ tip.silence
        }}<span class="dm-dtip__status" :data-status="tip.status">{{ tip.statusText }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* The design's dwarf-tooltip.css, rule for rule. */
.dm-dtip {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 8px;
  align-items: start;
}
.dm-dtip__lines {
  display: grid;
  min-width: 0;
  gap: 4px;
}
.dm-dtip__name {
  font: var(--fs-section) / 1.1 var(--f-label);
  color: var(--parchment);
}
.dm-dtip__base {
  margin-top: -4px;
  font: var(--fs-meta) / 1.3 var(--f-meta);
  color: var(--ink-faint);
}
.dm-dtip__line {
  color: var(--ink-soft);
  white-space: nowrap;
}
.dm-dtip__line b {
  font-weight: 400;
  color: var(--ink);
}
.dm-dtip__status[data-status='asking'] {
  color: var(--brass);
}
.dm-dtip__status[data-status='working'] {
  color: var(--ok);
}
.dm-dtip__status[data-status='asleep'] {
  color: var(--ink-faint);
}
</style>
