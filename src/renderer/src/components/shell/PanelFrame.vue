<script setup lang="ts">
/**
 * The design's bordered panel frame (#90) — the one surface every screen in the
 * shell is drawn on.
 *
 * The source lists it as a shared component with named variants rather than as
 * a style each screen repeats, so it is one component here for the same reason:
 * a corrected border weight is one edit, and a new screen cannot invent a
 * seventh way to draw the same box.
 *
 * `settings` is the heavy 4px frame the settings panel sits in. `plain` is the
 * default frame the mine column sits in. The `map` variant, the old 21px map
 * container, went with #635: the redesigned Map page stands in the page column
 * on its own, as the Mines page does.
 */
withDefaults(
  defineProps<{
    variant?: 'settings' | 'plain'
  }>(),
  { variant: 'plain' }
)
</script>

<template>
  <div class="panel-frame" :class="`is-${variant}`">
    <slot />
  </div>
</template>

<style scoped>
.panel-frame {
  position: relative;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border: var(--border-highlight);
  border-radius: var(--radius-default);
  background: var(--color-panel-deep);
}
.panel-frame.is-settings {
  border: var(--border-heavy);
}
/* Every screen mounted inside fills the frame rather than sitting in a corner. */
.panel-frame > :deep(*) {
  flex: 1;
  min-height: 0;
}
</style>
