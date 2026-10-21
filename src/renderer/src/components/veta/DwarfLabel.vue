<script setup lang="ts">
/*
 * A Veta dwarf's one-line hover label (`.dm-chamber__label`, DS/docs/components.md, Mine chamber; US-VETA-005.AC01,
 * AC08; 07 S24.19; ISSUE-290): "`<name>` · `<status>` · silent `<silence>`", centred on the dwarf it names on every
 * edge, beyond the raised tab. Its place is worked out by `labelPlace`; it is drawn only while its dwarf is hovered,
 * and shows once the window holds its room (`on`). It takes no pointer and opens nothing.
 */
import type { LabelSide } from '../../lib/veta/dwarfLabel'

defineProps<{
  text: string
  /** Where the chamber's tab rises: toward the screen. */
  side: LabelSide
  /** Its inline place in the chamber (`labelPlace`). */
  place: Record<string, string>
  /** The window holds its room: it may show. */
  on: boolean
}>()
</script>

<template>
  <span
    class="veta-dwarf-label"
    :class="{ 'is-on': on }"
    :style="place"
    :data-side="side"
    aria-hidden="true"
    data-veta-dwarf-label
    >{{ text }}</span
  >
</template>

<style scoped>
/* `.dm-chamber__label`: one line on rock, its 2 px brass edge notched at the corners. */
.veta-dwarf-label {
  position: absolute;
  z-index: 5;
  box-sizing: border-box;
  padding: 4px 6px;
  font: 400 var(--fs-meta) / 1 var(--f-meta);
  color: var(--parchment);
  white-space: nowrap;
  background: var(--rock-lo);
  box-shadow:
    0 -2px 0 0 var(--brass-lo),
    0 2px 0 0 var(--brass-lo),
    -2px 0 0 0 var(--brass-lo),
    2px 0 0 0 var(--brass-lo);
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--dur-fast) var(--ease-step);
}

/* Its inline left or top marks the dwarf's centre, not its own corner. */
.veta-dwarf-label[data-side='top'],
.veta-dwarf-label[data-side='bottom'] {
  transform: translateX(-50%);
}

.veta-dwarf-label[data-side='left'],
.veta-dwarf-label[data-side='right'] {
  transform: translateY(-50%);
}

.veta-dwarf-label.is-on {
  opacity: 1;
}
</style>
