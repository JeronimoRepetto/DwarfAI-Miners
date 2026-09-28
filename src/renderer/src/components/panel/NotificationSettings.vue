<script setup lang="ts">
import ToggleSwitch from '../controls/ToggleSwitch.vue'
import SettingsRow from './SettingsRow.vue'

/**
 * Settings › Notifications (#316, #635): one row, "System notifications", with its switch.
 *
 * ONE control, deliberately. #316 rules out per-mine and per-kind switches, so a section with a
 * single switch is the honest shape rather than a group waiting to be filled. The copy is today's
 * (screens/settings.md: "The copy follows NotificationSettings.vue"); the row is the design's.
 *
 * Presentational, like every settings piece: the stored switch arrives as a prop and the intent
 * leaves as one `change` event, so App.vue keeps owning the IPC and the "render only what main
 * verified" rule stays in exactly one place. The switch is held: a press shows its new state only
 * once main has answered with it.
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
  <SettingsRow
    label="System notifications"
    help="A question or an approval waiting in a mine, and the end of a turn, reach you through the system when the panel is hidden or another mine is open. The mine on screen is never announced."
  >
    <ToggleSwitch
      class="notifications-enabled"
      label="Show system notifications"
      held
      :on="props.enabled"
      :title="
        props.enabled
          ? 'A question, an approval or a finished turn in a mine you are not looking at reaches you through the system'
          : 'Nothing is sent to the system; a mine only says what it is waiting for on its own screen'
      "
      @update:on="emit('change', $event)"
    />
  </SettingsRow>
</template>
