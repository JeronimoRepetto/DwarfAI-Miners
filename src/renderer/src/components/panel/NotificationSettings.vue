<script setup lang="ts">
/**
 * The Notifications section of the Settings screen (#316).
 *
 * A maintainer-specified EXTENSION of `screens/settings.md`, like the Audio
 * section #174 added — and the source file already anticipates it, naming this
 * switch as joining the same gap between Audio and Data Base. The amendment
 * text is proposed with this change and the maintainer applies it (ui-rebuild
 * discipline); nothing here invents a shape. Everything drawn reuses the
 * design's existing vocabulary: the section label Position, Audio and Data Base
 * share, and the shared button model that Audio's "Music at startup" and
 * Settings' own "Always on top" already draw — pressed is the active control,
 * unpressed fades to the deep background.
 *
 * ONE control, deliberately. #316 rules out per-mine and per-kind switches in
 * this slice, so a section with a single button is the honest shape rather than
 * a group waiting to be filled.
 *
 * Presentational, like every settings piece: the stored switch arrives as a
 * prop and the intent leaves as one `change` event, so App.vue keeps owning the
 * IPC and the "render only what main verified" rule stays in exactly one place.
 * A press shows its new state only once main has answered with it.
 */
const props = defineProps<{
  /** What main STORED, never what was last pressed. */
  enabled: boolean
}>()

const emit = defineEmits<{
  /** The switch should take this value. */
  change: [enabled: boolean]
}>()
</script>

<template>
  <section class="notification-settings">
    <span class="field-label">Notifications</span>

    <div class="switch-row">
      <button
        class="notifications-enabled"
        type="button"
        aria-label="Show system notifications"
        :aria-pressed="props.enabled ? 'true' : 'false'"
        :title="
          props.enabled
            ? 'A question, an approval or a finished turn in a mine you are not looking at reaches you through the system'
            : 'Nothing is sent to the system; a mine only says what it is waiting for on its own screen'
        "
        @click="emit('change', !props.enabled)"
      >
        System notifications
      </button>
    </div>

    <p class="hint">
      A question or an approval waiting in a mine, and the end of a turn, reach you through the
      system when the panel is hidden or another mine is open. The mine on screen is never
      announced.
    </p>
  </section>
</template>

<style scoped>
/* The Audio section's own layout, because this sits beside it and a second
   spacing rule for one button would read as a different kind of section. */
.notification-settings {
  display: flex;
  flex-direction: column;
  gap: var(--space-settings);
}
.field-label {
  padding-top: var(--space-settings);
  color: var(--color-cream);
  font-size: var(--text-section);
}
.switch-row {
  display: flex;
}
/* The shared button model (components.md), identical to "Music at startup"
   and "Always on top": pressed reads as an active control, unpressed fades to
   the deep background. */
.notifications-enabled {
  padding: 6px var(--space-settings);
  border: var(--border-active);
  border-radius: var(--radius-default);
  color: var(--color-cream);
  background: var(--color-control);
  font: inherit;
  font-size: var(--text-meta);
  cursor: pointer;
}
.notifications-enabled[aria-pressed='false'] {
  border: 2px solid var(--color-control);
  color: var(--color-control);
  background: var(--color-panel-deep);
}
.notifications-enabled:focus-visible {
  outline: 2px solid var(--color-cream);
  outline-offset: 2px;
}
.hint {
  margin: 0;
  color: var(--color-cream);
  font-size: var(--text-helper);
  line-height: 1.4;
}
</style>
