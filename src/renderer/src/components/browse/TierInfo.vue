<script setup lang="ts">
/*
 * The tier and ore explainer (#635), `organisms/tier-info` in the design: the five tiers in
 * canonical order, each with its mound, its chip and its range; what one unit of each material is
 * worth; and the rule that materials never convert. The Mines page's corner opens it as the wide
 * dialog "Tiers and ore". What it says is lib/browse/tierInfo's.
 */
import { computed } from 'vue'
import TierChip from '../controls/TierChip.vue'
import OreCapsule from '../vault/OreCapsule.vue'
import { MOUND_SRC } from '../../lib/art'
import { TIER_NOTE, grainRows, tierRanges, type TierThresholds } from '../../lib/browse/tierInfo'

const props = withDefaults(defineProps<{ thresholds?: TierThresholds }>(), {
  thresholds: undefined
})

const ranges = computed(() => tierRanges(props.thresholds))
const grains = grainRows()
</script>

<template>
  <div class="dm-tinfo">
    <p class="dm-tinfo__h">Tiers</p>
    <div class="dm-tinfo__list">
      <div v-for="row in ranges" :key="row.tier" class="dm-tinfo__row">
        <img :src="MOUND_SRC[row.tier]" alt="" />
        <TierChip :tier="row.tier" />
        <span class="dm-tinfo__range">{{ row.range }}</span>
      </div>
    </div>
    <p class="dm-tinfo__h">Ore</p>
    <div class="dm-tinfo__grains">
      <div v-for="grain in grains" :key="grain.material" class="dm-tinfo__grain">
        <OreCapsule :material="grain.material" :units="1" />{{ grain.text }}
      </div>
    </div>
    <p class="dm-tinfo__note">{{ TIER_NOTE }}</p>
  </div>
</template>

<style scoped>
/* The design's tier-info.css, rule for rule. */
.dm-tinfo {
  display: grid;
  gap: 12px;
}
.dm-tinfo__list {
  display: grid;
  gap: 4px;
}
.dm-tinfo__row {
  display: grid;
  grid-template-columns: 56px 92px minmax(0, 1fr);
  gap: 10px;
  padding: 4px 6px;
  background: var(--wood-lo);
  align-items: center;
}
.dm-tinfo__row img {
  width: 52px;
  height: 40px;
  object-fit: contain;
}
.dm-tinfo__range {
  font: var(--fs-meta) / 1.2 var(--f-meta);
  color: var(--ink-soft);
  font-variant-numeric: tabular-nums;
}
.dm-tinfo__h {
  font: var(--fs-meta) / 1 var(--f-meta);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--gold);
}
.dm-tinfo__grains {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 4px;
}
.dm-tinfo__grain {
  display: grid;
  gap: 2px;
  padding: 4px;
  font: var(--fs-meta) / 1.2 var(--f-meta);
  color: var(--ink-faint);
  background: var(--wood-lo);
}
.dm-tinfo__grain .dm-ore {
  justify-self: start;
}
.dm-tinfo__note {
  font: var(--fs-meta) / 1.35 var(--f-meta);
  color: var(--ink-faint);
}
</style>
