<script setup lang="ts">
/*
 * The Control-room mosaic (ISSUE-298, S-034-1): N live mine columns side by side in one sideways
 * scroller, every column always in the DOM (no virtualization, ADR-034 item 5).
 *
 * One IntersectionObserver on the scroller tells each column whether any of it is inside the
 * viewport. The root is drawn in by 1px on each side: a column that only touches the viewport's
 * edge (the fifth column at the start, the one before the last four at the end) is outside it,
 * where the platform would count an edge-adjacent box as intersecting.
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { Mine } from '../../../src/renderer/src/types'
import ClockedColumn from './ClockedColumn.vue'

defineProps<{ mines: readonly Mine[]; degradation: boolean }>()
const mosaic = ref<HTMLElement | null>(null)
const columns = ref<InstanceType<typeof ClockedColumn>[]>([])
defineExpose({ mosaic })

let observer: IntersectionObserver | undefined
onMounted(() => {
  const byElement = new Map<Element, InstanceType<typeof ClockedColumn>>()
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) byElement.get(entry.target)?.setInView(entry.isIntersecting)
    },
    { root: mosaic.value, rootMargin: '0px -1px 0px -1px', threshold: 0 }
  )
  for (const column of columns.value) {
    const element = column.$el as Element
    byElement.set(element, column)
    observer.observe(element)
  }
})
onBeforeUnmount(() => observer?.disconnect())
</script>

<template>
  <main ref="mosaic" class="cr-mosaic">
    <ClockedColumn
      v-for="(mine, index) in mines"
      :key="mine.id"
      ref="columns"
      :mine="mine"
      :index="index"
      :degradation="degradation"
    />
  </main>
</template>

<style scoped>
.cr-mosaic {
  display: flex;
  position: relative;
  width: 100vw;
  height: 100vh;
  overflow-x: auto;
  overflow-y: hidden;
  background: var(--rock-lo);
}
</style>
