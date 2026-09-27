<script setup lang="ts">
/*
 * One setting (#635), `molecules/settings-row` in the design: what it is on the left — its label
 * and help — and its control on the right, one 2px rule between rows. `stack` puts the control
 * under the text, for a control that needs the width (a slider, a list, a row of selects); the
 * danger zone is the variant for a destructive action, and nothing destructive stands outside it.
 *
 * The label names the control and the help is its associated text (components.md, Settings row,
 * Accessibility): both ids reach the control slot, so a control can point at them. Extra lines
 * under the help (an error saying why the last change did not take) go in the `notes` slot.
 */
import { useId } from 'vue'

withDefaults(
  defineProps<{
    label: string
    help?: string
    tone?: 'danger'
    stack?: boolean
  }>(),
  { help: undefined, tone: undefined, stack: false }
)

const labelId = useId()
const helpId = useId()
</script>

<template>
  <div class="dm-srow" :class="{ 'dm-srow--danger': tone === 'danger', 'dm-srow--stack': stack }">
    <div :id="labelId" class="dm-srow__label">{{ label }}</div>
    <p v-if="help !== undefined" :id="helpId" class="dm-srow__help">{{ help }}</p>
    <slot name="notes" />
    <div class="dm-srow__control">
      <slot :label-id="labelId" :help-id="help !== undefined ? helpId : undefined" />
    </div>
  </div>
</template>

<style scoped>
/* The design's settings-row.css, rule for rule. */
.dm-srow {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 4px 12px;
  padding: 10px 2px;
  box-shadow: 0 2px 0 0 var(--wood-lo);
}
.dm-srow:last-child {
  box-shadow: none;
}
.dm-srow__label {
  font: 400 var(--fs-section) / 1.2 var(--f-label);
  color: var(--parchment);
}
.dm-srow__help,
:slotted(.dm-srow__help) {
  grid-column: 1;
  font: 400 var(--fs-meta) / 1.35 var(--f-meta);
  color: var(--ink-faint);
}
/*
 * Controls wrap rather than squeeze: a select never shrinks below its longest option (atoms/select).
 * 8px between neighbours, as the Spacing ruling asks.
 */
.dm-srow__control {
  grid-column: 2;
  grid-row: 1 / span 2;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  justify-self: end;
}
.dm-srow--stack {
  grid-template-columns: minmax(0, 1fr);
}
.dm-srow--stack .dm-srow__control {
  grid-column: 1;
  grid-row: auto;
  justify-self: stretch;
}
.dm-srow--danger {
  padding: 12px;
  margin-top: 8px;
  background: var(--danger-lo);
  box-shadow:
    0 -2px 0 0 var(--danger),
    0 2px 0 0 var(--danger),
    -2px 0 0 0 var(--danger),
    2px 0 0 0 var(--danger);
}
.dm-srow--danger .dm-srow__label {
  color: var(--danger-hi);
}
.dm-srow--danger .dm-srow__help,
.dm-srow--danger :slotted(.dm-srow__help) {
  color: var(--ink-soft);
}
</style>
