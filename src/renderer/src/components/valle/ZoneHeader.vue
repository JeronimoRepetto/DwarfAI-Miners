<script setup lang="ts">
/*
 * A Valle zone's header (`DS/docs/screens/valle.md` VA1, VA3; `organisms/mine-zone`; 07 machine 31; ISSUE-304): the
 * mine's tier and name, then what the zone shows now when it is not its mine ("· Map", "· Mines", "· History"), then
 * its tools (the `tools` slot: `⤢` in the Control room, History in the Work front) and the "⋯" that opens the zone
 * menu (S31.01).
 *
 * The wood plate behind it is its own layer (`.dm-vz__barbg`), so a dive stretches the plate while the title and the
 * tools only move (flip.ts; `DS` mine-zone.css: nothing that carries pixels or letters is ever scaled).
 *
 * The "⋯" says whether its menu is open (`aria-expanded`); when the menu closes with the focus nowhere (Esc, a pick),
 * the focus comes back to it (NFR-A11Y-02).
 */
import type { ZoneContent } from '@dwarfai/contracts'
import { computed, shallowRef, watch } from 'vue'
import { zoneSuffix } from '../../lib/valle/zone'
import type { MineTier } from '../../types'
import ActionButton from '../controls/ActionButton.vue'
import TierChip from '../controls/TierChip.vue'

const props = defineProps<{
  name: string
  content: ZoneContent
  /** This zone's menu is open. */
  menuOpen: boolean
  /** The mine's tier, once known: its chip leads the title. */
  tier?: MineTier | null
}>()
const emit = defineEmits<{ menu: [] }>()

const suffix = computed(() => zoneSuffix(props.content))
const more = shallowRef<InstanceType<typeof ActionButton> | null>(null)

watch(
  () => props.menuOpen,
  (open, was) => {
    if (open || !was) return
    const active = document.activeElement
    if (active === null || active === document.body)
      (more.value?.$el as HTMLElement | undefined)?.focus()
  },
  { flush: 'post' }
)
</script>

<template>
  <header class="dm-vz__bar">
    <span class="dm-vz__barbg m-mat" aria-hidden="true"></span>
    <div class="dm-vz__title">
      <TierChip v-if="tier" :tier="tier" />
      <span class="dm-vz__name" :title="name"
        ><bdi>{{ name }}</bdi></span
      >
      <span v-if="suffix !== ''" class="dm-vz__suffix" data-zone-suffix>{{ suffix }}</span>
    </div>
    <div class="dm-vz__tools">
      <slot name="tools" />
      <ActionButton
        ref="more"
        class="dm-vz__more"
        icon="more"
        size="sm"
        title="Mine options"
        haspopup="menu"
        :aria-expanded="menuOpen ? 'true' : 'false'"
        data-zone-more
        @click="emit('menu')"
      />
    </div>
  </header>
</template>

<style scoped>
/* `DS` mine-zone.css, `.dm-vz__bar` … `.dm-vz__tools`. */
.dm-vz__bar {
  position: relative;
  display: flex;
  align-items: center;
  gap: 2px;
  height: 44px;
  padding: 0 2px 0 8px;
  min-width: 0;
}
.dm-vz__barbg {
  --mat-fill: var(--wood);
  --mat-hi: var(--wood-hi);
  --mat-lo: var(--wood-lo);
  position: absolute;
  inset: 0;
  transform-origin: 0 0;
  pointer-events: none;
}
.dm-vz__title {
  position: relative;
  display: flex;
  flex: 1;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.dm-vz__name {
  min-width: 0;
  overflow: hidden;
  font: 400 var(--fs-section) / 1.1 var(--f-label);
  color: var(--parchment);
  text-overflow: ellipsis;
  white-space: nowrap;
}
/*
 * `.dm-vz__what`: what the zone shows when it is not its mine. The name's sibling and `flex: none`, so a
 * long name gives way with its ellipsis and this stays whole (VQA-14).
 */
.dm-vz__suffix {
  flex: none;
  font: 400 var(--fs-meta) / 1 var(--f-meta);
  color: var(--ink-faint);
}
.dm-vz__tools {
  position: relative;
  display: flex;
  flex: none;
  align-items: center;
}
</style>
