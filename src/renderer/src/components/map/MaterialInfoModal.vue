<script setup lang="ts">
/**
 * Information popup showing the material-to-tokens correlation table (#506).
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
 * (`MapView.vue`) wraps its `v-if` in `<AnimatePresence>`, which drives the
 * enter/exit — this component only carries `popVariants`. A hang while this
 * popup's window is hidden is harmless (it does not gate geometry), the
 * design decision after T0 that permits `AnimatePresence` here.
 */
import { motion } from 'motion-v'
import { NUGGET_SRC } from '../../lib/art'
import { popVariants } from '../../lib/shell/presence'
import { MATERIALS, MATERIAL_TOKENS_PER_UNIT } from '../../types'

const emit = defineEmits<{ close: [] }>()
</script>

<template>
  <motion.div class="info-modal" role="dialog" v-bind="popVariants" @keydown.escape="emit('close')">
    <header class="modal-head">
      <h2 class="modal-title">Material values</h2>
      <button class="modal-close" type="button" aria-label="Close" @click="emit('close')">
        &times;
      </button>
    </header>
    <div class="info-scroll">
      <table class="info-table">
        <thead>
          <tr>
            <th>Material</th>
            <th class="info-tokens-header">Tokens per unit</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="material in MATERIALS" :key="material">
            <td class="info-material">
              <img class="info-nugget" :src="NUGGET_SRC[material]" alt="" draggable="false" />{{
                material
              }}
            </td>
            <td class="info-tokens">{{ MATERIAL_TOKENS_PER_UNIT[material].toLocaleString() }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </motion.div>
</template>

<style scoped>
/* components.md's Confirmation modal shell, positioned over the map frame it
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
.info-tokens-header {
  text-align: center;
}
.info-tokens {
  color: var(--color-accent);
  text-align: center;
}
.info-nugget {
  display: inline-block;
  width: 14px;
  height: auto;
  margin-right: 4px;
  vertical-align: middle;
  user-select: none;
}
</style>
