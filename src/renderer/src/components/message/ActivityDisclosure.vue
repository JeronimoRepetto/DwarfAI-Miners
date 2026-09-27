<script setup lang="ts">
/*
 * One run of tool steps folded to a line (#294, #635), `molecules/activity` in the design: a
 * disclosure button with the run's label, and the step list it opens. A read or edit step names a
 * file, so it is a button that opens it (#279), styled as the text it is. Shared by the
 * MessagePanel and the mine history, whose markup it was until this slice extracted it. Which runs
 * are open is the host's, per run; this reports a press.
 */
defineProps<{
  label: string
  open: boolean
  /** The steps, each with the path it opens when it names one (#279). */
  lines: readonly { key: string; text: string; target?: string; title?: string }[]
}>()

const emit = defineEmits<{
  toggle: []
  /** A step's own path was pressed: the step's key and its exact target, never its text. */
  'open-path': [payload: { key: string; target: string }]
}>()
</script>

<template>
  <div class="dm-activity">
    <button
      class="dm-activity__toggle"
      type="button"
      :aria-expanded="open ? 'true' : 'false'"
      @click="emit('toggle')"
    >
      <span class="dm-activity__caret"></span>{{ label }}
    </button>
    <ul class="dm-activity__list" :hidden="!open">
      <li v-for="line in lines" :key="line.key">
        <button
          v-if="line.target !== undefined"
          class="dm-activity__path"
          type="button"
          :data-row-key="line.key"
          :title="line.title ?? line.text"
          @click="emit('open-path', { key: line.key, target: line.target })"
        >
          {{ line.text }}
        </button>
        <template v-else>{{ line.text }}</template>
      </li>
    </ul>
  </div>
</template>

<style scoped>
/* The design's activity.css. */
.dm-activity {
  display: grid;
  gap: 2px;
  margin: var(--px);
  justify-self: stretch;
}
.dm-activity__toggle {
  display: flex;
  min-height: var(--hit);
  gap: 6px;
  padding: 0 8px;
  font: var(--fs-meta) / 1 var(--f-meta);
  color: var(--ink-soft);
  background: var(--wood);
  box-shadow: inset 2px 0 0 0 var(--brass-lo);
  align-items: center;
  text-align: left;
}
.dm-activity__toggle:hover {
  color: var(--ink);
  background: var(--wood-hi);
  box-shadow: inset 2px 0 0 0 var(--brass);
}
.dm-activity__caret {
  width: 0;
  height: 0;
  border-left: 5px solid var(--brass);
  border-top: 4px solid transparent;
  border-bottom: 4px solid transparent;
  transition: transform var(--dur-fast) var(--ease-step);
}
.dm-activity__toggle[aria-expanded='true'] .dm-activity__caret {
  transform: rotate(90deg);
}
.dm-activity__list {
  display: grid;
  gap: 2px;
  margin: 0;
  padding: 4px 8px 6px 20px;
  background: var(--wood-lo);
  list-style: none;
  animation: dm-fade-in var(--dur-base) var(--ease-out) both;
}
.dm-activity__list[hidden] {
  display: none;
}
.dm-activity__list li {
  position: relative;
  font: var(--fs-meta) / 1.4 var(--f-meta);
  color: var(--ink-soft);
}
.dm-activity__list li::before {
  content: '';
  width: 4px;
  height: 4px;
  position: absolute;
  left: -10px;
  top: 6px;
  background: var(--ok);
}
.dm-activity__list li:last-child::before {
  background: var(--brass);
}
/*
 * A read or edit step opens its own file (#279): a button styled as the text it is, underlined
 * only for the pointer or the keyboard, so nothing else about the line changes.
 */
.dm-activity__path {
  font: inherit;
  color: inherit;
  text-align: left;
}
.dm-activity__path:hover,
.dm-activity__path:focus-visible {
  text-decoration: underline;
}
@keyframes dm-fade-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
</style>
