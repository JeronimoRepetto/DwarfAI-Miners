<script setup lang="ts">
import { computed } from 'vue'
import { describeEffort } from '../../lib/delivery/effort'
import { observerLabel } from '../../lib/dwarf/observerLabel'
import { describeSilence } from '../../lib/presentation'
import type { Dwarf } from '../../types'

const props = defineProps<{ dwarf: Dwarf }>()

function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1)
}

function roleLabel(): string {
  return props.dwarf.role === 'foreman' ? 'Foreman' : 'Worker'
}

/**
 * The exact silence figure (issue #47), shown whenever the provider knows it —
 * not only past the threshold. This is the detail surface: the sprite is what
 * says "something is wrong here" at a glance, and the number beside the name
 * and model is what a person weighs before deciding to kick. A short figure on
 * a busy dwarf is not clutter, it is the contrast that makes a long one legible.
 *
 * Absent where the provider has no per-agent evidence (Codex keeps no
 * equivalent transcript). Nothing is rendered at all in that case, because an
 * empty row or a fabricated zero would both claim knowledge we do not have.
 */
const silence = computed(() =>
  props.dwarf.silentForMs === undefined ? undefined : describeSilence(props.dwarf.silentForMs)
)
</script>

<template>
  <div class="dwarf-tooltip" role="tooltip">
    <strong>{{ dwarf.name }}</strong>
    <span>{{ roleLabel() }} · {{ observerLabel(dwarf.provider) }}</span>
    <span>{{ dwarf.model ?? 'Model unknown' }}</span>
    <span v-if="dwarf.effort">Effort: {{ describeEffort(dwarf.provider, dwarf.effort) }}</span>
    <span v-if="silence" class="dwarf-silence">{{ silence }}</span>
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
  font-size: var(--text-meta);
  line-height: 1.3;
  text-align: left;
}
.dwarf-tooltip strong {
  font-size: var(--text-meta);
}
.dwarf-tooltip span {
  color: var(--ink-dim);
}
/*
 * The silence figure is the one line here a user may act on, so it reads a
 * shade louder than the rest of the detail without becoming a warning: the
 * tooltip reports what is known, it does not pronounce the dwarf dead.
 */
.dwarf-tooltip .dwarf-silence {
  color: var(--lantern-soft);
}
.dwarf-tooltip em {
  color: var(--lantern-soft);
  font-style: normal;
  font-size: var(--text-meta);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
</style>
