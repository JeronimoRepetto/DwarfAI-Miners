<script setup lang="ts">
/**
 * Information popup showing the tier weight thresholds (#538).
 *
 * Reuses components.md's Confirmation modal shell — the same geometry the
 * reset and removal confirmations draw — because the design source never
 * specifies a separate info-popup shape, and inventing one would drift from
 * the shared panel language.
 *
 * Presentational: the only state it owns is its own presence, and the only
 * thing that leaves is the dismissal signal.
 *
 * The root is `motion.div` rather than a plain `div` (#566 T3): the caller
 * (`MinesPanel.vue`) wraps its `v-if` in `<AnimatePresence>`, which is what
 * actually drives the enter/exit — this component only has to hand it a
 * `motion.*` element carrying `popVariants` and change no markup otherwise.
 * A hang while this popup's window is hidden is harmless (it does not gate
 * geometry), which is exactly the design decision after T0 that permits
 * `AnimatePresence` here and forbids it on the bounded runner's own surfaces.
 */
import { motion } from 'motion-v'
import { MOUND_SRC } from '../../lib/art'
import { popVariants, pressHoverVariants } from '../../lib/shell/presence'
import { MINE_TIERS, TIER_WEIGHT_THRESHOLDS_KB } from '../../types'

const emit = defineEmits<{ close: [] }>()

function thresholdText(tier: string): string {
  if (tier === 'bronze') return 'Any size'
  const key = `${tier}Kb` as keyof typeof TIER_WEIGHT_THRESHOLDS_KB
  const kb = TIER_WEIGHT_THRESHOLDS_KB[key]
  return `≥ ${kb.toLocaleString()} KB`
}
</script>

<template>
  <motion.div class="info-modal" role="dialog" v-bind="popVariants" @keydown.escape="emit('close')">
    <header class="modal-head">
      <h2 class="modal-title">Tier thresholds</h2>
      <motion.button
        class="modal-close"
        type="button"
        aria-label="Close"
        v-bind="pressHoverVariants"
        @click="emit('close')"
      >
        &times;
      </motion.button>
    </header>
    <div class="info-scroll">
      <table class="info-table">
        <thead>
          <tr>
            <th>Tier</th>
            <th class="info-threshold-header">Minimum size</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="tier in MINE_TIERS" :key="tier">
            <td class="info-tier">
              <img class="info-mound" :src="MOUND_SRC[tier]" alt="" draggable="false" />{{
                tier.charAt(0).toUpperCase() + tier.slice(1)
              }}
            </td>
            <td class="info-threshold">{{ thresholdText(tier) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </motion.div>
</template>

<style scoped>
/* components.md's Confirmation modal shell, positioned over the panel frame it
   belongs to (`position: relative` there) — the same overlay RemoveMineModal
   uses inside the Mines panel. */
.info-modal {
  position: absolute;
  z-index: 96;
  inset: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-settings);
  width: 326px;
  height: 265px;
  margin: auto;
  padding: var(--space-modal-margin);
  border: var(--border-heavy);
  border-radius: var(--radius-default);
  background: var(--color-panel-deep);
  box-shadow: var(--elevation-5);
}
.modal-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
}
.modal-title {
  margin: 0;
  color: var(--color-accent);
  font: inherit;
  font-size: var(--text-headline);
}
.modal-close {
  padding: 0;
  border: 0;
  color: var(--color-cream);
  cursor: pointer;
  background: transparent;
  font: inherit;
  font-size: var(--text-title);
  line-height: 1;
}
.modal-close:focus-visible {
  outline: 2px solid var(--color-cream);
  outline-offset: 2px;
}
/* The table is held in a scrollable area so a longer list (or a smaller
   viewport) never pushes the modal's own box past its declared size. */
.info-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.info-table {
  width: 100%;
  border-collapse: collapse;
  color: var(--color-cream);
  font-size: var(--text-helper);
  line-height: 1.4;
}
.info-table th {
  padding: 4px 6px;
  border-bottom: 1px solid var(--color-accent);
  color: var(--color-accent);
  text-align: left;
  font: inherit;
  font-size: var(--text-meta);
}
.info-table td {
  padding: 4px 6px;
}
.info-threshold-header {
  text-align: center;
}
.info-threshold {
  color: var(--color-accent);
  text-align: center;
}
/*
 * The entrance painting the tier's name refers to, at the scale
 * MaterialInfoModal draws its nuggets at — wider, because a mound is landscape
 * where a nugget is square, and the name has to stay the row's subject.
 * Decorative: `alt=""` because the tier text beside it already says which mine
 * this is, and a second reading of the same word helps nobody.
 */
.info-mound {
  display: inline-block;
  width: 28px;
  height: auto;
  margin-right: 6px;
  vertical-align: middle;
  user-select: none;
}
</style>
