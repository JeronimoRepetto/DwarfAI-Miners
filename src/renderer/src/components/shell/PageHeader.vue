<script setup lang="ts">
/*
 * The page header plate (#635), `organisms/page-header` in the design: the page's title, then an
 * optional search that takes the room left, then the page's own tools, all on one wood plate at
 * one height. The sort button names the order in force ("Sort: <label>"); which orders there are
 * and how they cycle belong to the page, so the header only asks for the next one. A page with no
 * search keeps its tools at the far end.
 */
import ActionButton from '../controls/ActionButton.vue'
import InputField from '../controls/InputField.vue'

withDefaults(
  defineProps<{
    title: string
    search?: boolean
    searchValue?: string
    searchPlaceholder?: string
    /** The order in force, named on the sort button; no sort button without one. */
    sortLabel?: string
    /** What the add button adds, as its name; no add button without one. */
    addLabel?: string
    addDisabled?: boolean
  }>(),
  {
    search: false,
    searchValue: '',
    searchPlaceholder: 'Search by name',
    sortLabel: undefined,
    addLabel: undefined,
    addDisabled: false
  }
)
const emit = defineEmits<{ search: [value: string]; sort: []; add: [] }>()
</script>

<template>
  <header class="dm-phead m-mat">
    <h1 class="dm-phead__title">{{ title }}</h1>
    <div v-if="search" class="dm-phead__search">
      <InputField
        search
        :placeholder="searchPlaceholder"
        label="Search mines"
        :value="searchValue"
        @update:value="emit('search', $event)"
      />
    </div>
    <span v-else class="dm-phead__grow"></span>
    <div class="dm-phead__actions">
      <slot />
      <ActionButton
        v-if="sortLabel !== undefined"
        icon="sort"
        size="sm"
        :title="'Sort: ' + sortLabel"
        @click="emit('sort')"
      />
      <ActionButton
        v-if="addLabel !== undefined"
        icon="add"
        size="sm"
        :title="addLabel"
        :disabled="addDisabled"
        @click="emit('add')"
      />
    </div>
  </header>
</template>

<style scoped>
/* The design's page-header.css, rule for rule. */
.dm-phead {
  --mat-fill: var(--wood);
  --mat-hi: var(--wood-hi);
  --mat-lo: var(--wood-lo);
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 2px;
  padding: 6px 6px 6px 12px;
}
.dm-phead__title {
  margin: 0 4px 0 0;
  font: var(--fs-title) / 1 var(--f-display);
  color: var(--gold);
  white-space: nowrap;
}
.dm-phead__search {
  flex: 1;
  min-width: 0;
}
.dm-phead__search .dm-field {
  margin: 2px;
}
.dm-phead__grow {
  flex: 1;
}
.dm-phead__actions {
  display: flex;
  gap: 2px;
}
</style>
