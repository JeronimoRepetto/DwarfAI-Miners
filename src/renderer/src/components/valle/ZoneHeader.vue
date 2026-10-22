<script setup lang="ts">
/*
 * A Valle zone's header (`DS/docs/screens/valle.md` VA1, VA3; `organisms/mine-zone`; 07 machine 31; ISSUE-304): the
 * mine's name, then what the zone shows now when it is not its mine ("· Map", "· Mines", "· History"), then its tools
 * (the `tools` slot: `⤢` in the Control room) and the "⋯" that opens the zone menu (S31.01).
 *
 * The "⋯" says whether its menu is open (`aria-expanded`); when the menu closes with the focus nowhere (Esc, a pick),
 * the focus comes back to it (NFR-A11Y-02).
 */
import type { ZoneContent } from '@dwarfai/contracts'
import { computed, shallowRef, watch } from 'vue'
import { zoneSuffix } from '../../lib/valle/zone'

const props = defineProps<{
  name: string
  content: ZoneContent
  /** This zone's menu is open. */
  menuOpen: boolean
}>()
const emit = defineEmits<{ menu: [] }>()

const suffix = computed(() => zoneSuffix(props.content))
const more = shallowRef<HTMLButtonElement | null>(null)

watch(
  () => props.menuOpen,
  (open, was) => {
    if (open || !was) return
    const active = document.activeElement
    if (active === null || active === document.body) more.value?.focus()
  },
  { flush: 'post' }
)
</script>

<template>
  <header class="dm-vz__title">
    <span class="dm-vz__name"
      >{{ name
      }}<span v-if="suffix !== ''" class="dm-vz__suffix" data-zone-suffix>{{ suffix }}</span></span
    >
    <span class="dm-vz__tools">
      <slot name="tools" />
      <button
        ref="more"
        type="button"
        class="dm-vz__more"
        aria-label="Mine options"
        title="Mine options"
        aria-haspopup="menu"
        :aria-expanded="menuOpen ? 'true' : 'false'"
        data-zone-more
        @click="emit('menu')"
      >
        ⋯
      </button>
    </span>
  </header>
</template>

<style scoped>
.dm-vz__title {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  min-width: 0;
}
.dm-vz__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dm-vz__suffix {
  margin-inline-start: 0.5ch;
}
.dm-vz__tools {
  display: flex;
  flex: none;
  align-items: center;
  gap: 4px;
}
</style>
