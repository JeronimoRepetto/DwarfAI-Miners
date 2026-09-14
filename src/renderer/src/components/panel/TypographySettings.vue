<script setup lang="ts">
import type { InterfaceFont, MessagingFont, TypographyPreferences } from '../../types'
import { INTERFACE_FONTS, MESSAGING_FONTS } from '../../types'
import { fontFamilyLabel } from '../../lib/typography/fontFamilies'

/**
 * The Typography section of the Settings screen (#370).
 *
 * A maintainer-specified EXTENSION of `screens/settings.md`, like Audio (#174)
 * and Notifications (#316) before it — but unlike those two it has a home the
 * source names: after Position and before Audio. Everything drawn reuses the
 * design's existing vocabulary rather than inventing one: the section label
 * Position, Audio and Data Base share, and the segmented control Position
 * already draws, because these are the same kind of choice.
 *
 * TWO rows and not one theme. That is the acceptance criterion itself: somebody
 * may want the pixel identity on the chrome and a text face for an agent's
 * paragraphs, and a single control could not say that. Picking one family in
 * both rows is how the whole app becomes that face.
 *
 * Messaging is offered a NARROWER list, and the omission is the point: Tiny5
 * has one display weight, and #347's ruling — which this section carries
 * forward rather than reopening — is that a single-weight pixel face cannot
 * draw bold or carry a paragraph. It is absent rather than disabled, because a
 * disabled segment still reads as a choice somebody might make. The real
 * enforcement is at the wire boundary all the same (see
 * `parseTypographyPreferences`): a hand-edited userData document reaches the
 * renderer without passing through this component.
 *
 * Presentational, like every settings piece: the stored faces arrive as a prop
 * and the intent leaves as one `change` event carrying only the role that
 * moved, so App.vue keeps owning the IPC and the "render only what main
 * verified" rule stays in exactly one place.
 */
defineProps<{
  /** What main STORED, never what was last pressed. */
  preferences: TypographyPreferences
  /** True while a change is in flight; locks every segment (see useTypography.applying). */
  applying: boolean
}>()

const emit = defineEmits<{
  /**
   * One role should take this face. A PATCH rather than the whole document: the
   * owner merges it onto what is currently in force, so a row cannot revert a
   * change to the other role that landed between the press and this event.
   */
  change: [patch: Partial<TypographyPreferences>]
}>()

function selectInterface(font: InterfaceFont): void {
  emit('change', { interfaceFont: font })
}

function selectMessaging(font: MessagingFont): void {
  emit('change', { messagingFont: font })
}
</script>

<template>
  <section class="typography-settings">
    <span class="field-label">Typography</span>

    <div class="font-row">
      <span class="row-label">Interface</span>
      <div class="segments">
        <button
          v-for="font in INTERFACE_FONTS"
          :key="font"
          class="interface-font"
          type="button"
          :data-font="font"
          :class="{ 'is-selected': preferences.interfaceFont === font }"
          :aria-pressed="preferences.interfaceFont === font ? 'true' : 'false'"
          :disabled="applying"
          @click="selectInterface(font)"
        >
          {{ fontFamilyLabel(font) }}
        </button>
      </div>
    </div>

    <div class="font-row">
      <span class="row-label">Messaging</span>
      <div class="segments">
        <button
          v-for="font in MESSAGING_FONTS"
          :key="font"
          class="messaging-font"
          type="button"
          :data-font="font"
          :class="{ 'is-selected': preferences.messagingFont === font }"
          :aria-pressed="preferences.messagingFont === font ? 'true' : 'false'"
          :disabled="applying"
          @click="selectMessaging(font)"
        >
          {{ fontFamilyLabel(font) }}
        </button>
      </div>
    </div>

    <p class="hint">
      Interface sets every label, control and headline. Messaging sets what a dwarf or you says —
      the message panel and the launch panel. Tiny5 has one weight, so it is not offered for
      messages.
    </p>
  </section>
</template>

<style scoped>
/* The Position section's own layout, because this sits beside it and a second
   spacing rule for the same kind of choice would read as a different kind of
   section. */
.typography-settings {
  display: flex;
  flex-direction: column;
  gap: var(--space-settings);
}
.field-label {
  padding-top: var(--space-settings);
  color: var(--color-cream);
  font-size: var(--text-section);
}
/* Label then segments, stacked rather than in Audio's fixed label column: a
   font name is as wide as the family is called, and four of them beside a
   72px column would wrap into two ragged lines at the panel's own width. */
.font-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.row-label {
  color: var(--color-cream);
  font-size: var(--text-meta);
}
.segments {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-settings);
}
/* The shared button/segmented-control model (components.md), identical to
   Position: the selected segment reads as an active control, the others fade
   to the deep background — all of them stay clickable, since changing face is
   the point. Segments share the row rather than each taking a fixed width, and
   wrap when a narrow panel cannot hold four. */
.segments button {
  flex: 1 1 auto;
  padding: 6px var(--space-settings);
  border: 2px solid var(--color-control);
  border-radius: var(--radius-default);
  color: var(--color-control);
  cursor: pointer;
  background: var(--color-panel-deep);
  font: inherit;
  font-size: var(--text-meta);
  white-space: nowrap;
}
.segments button.is-selected {
  border: var(--border-active);
  color: var(--color-cream);
  background: var(--color-control);
}
.segments button:disabled {
  cursor: default;
}
.segments button:focus-visible {
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
