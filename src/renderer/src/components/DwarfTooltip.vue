<script setup lang="ts">
import type { Dwarf } from '../types'

const props = defineProps<{ dwarf: Dwarf }>()

function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1)
}

function roleLabel(): string {
  return props.dwarf.role === 'foreman' ? 'Foreman' : 'Worker'
}
</script>

<template>
  <div class="dwarf-tooltip" role="tooltip">
    <strong>{{ dwarf.name }}</strong>
    <span>{{ roleLabel() }} · {{ dwarf.provider }}</span>
    <span>{{ dwarf.model ?? 'Model unknown' }}</span>
    <span v-if="dwarf.effort">Effort: {{ dwarf.effort }}</span>
    <em>{{ capitalize(dwarf.status) }}</em>
  </div>
</template>

<style scoped>
.dwarf-tooltip {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: max-content;
  max-width: 190px;
  padding: 7px 9px;
  border: 1px solid var(--line-strong);
  border-radius: 7px;
  color: var(--ink);
  background: #15100bf2;
  box-shadow: 0 4px 14px #000a;
  font-size: 10px;
  line-height: 1.3;
  text-align: left;
}
.dwarf-tooltip strong {
  font-size: 11px;
}
.dwarf-tooltip span {
  color: var(--ink-dim);
}
.dwarf-tooltip em {
  color: var(--lantern-soft);
  font-style: normal;
  font-size: 9px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
</style>
