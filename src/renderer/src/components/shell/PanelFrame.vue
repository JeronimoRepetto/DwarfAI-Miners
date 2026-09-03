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
 * `map` is the map container from `screens/map.md` — 21px padding on every
 * side, a 2px border and elevation 5. `settings` is the heavy 4px frame the
 * settings and unavailable panels share. `plain` is the default frame the mine
 * column and the browse list sit in.
 */
withDefaults(
  defineProps<{
    variant?: 'map' | 'settings' | 'plain'
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
.panel-frame.is-map {
  padding: var(--space-map-pad);
  box-shadow: var(--elevation-5);
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
