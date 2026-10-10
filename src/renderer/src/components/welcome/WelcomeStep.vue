<script setup lang="ts">
/*
 * The first-run consent step, as the Panel shows it (ISSUE-224; AMENDMENT-7, OQ-68; 07 machine 41; UC-075; 14 §6.3):
 * the design's dialog (`molecules/dialog`, through ModalDialog: Tab trapped, focus held inside, in <body>) over the
 * window, with one settings row per offered option (`molecules/settings-row` with `atoms/toggle`), each on, and one
 * Activate. There is no close, skip or "Not now" control, and Esc closes nothing (US-SET-012.AC06): Activate with the
 * ticks as the person left them is the only way out, and it is the consent (ADR-016 item 5). Once answered, a
 * per-integration failure is one line naming the integrations, shown once with one dismiss (S41.05; 13 FM-148,
 * FM-149).
 *
 * Design draws no welcome step and no checkbox yet (design gaps recorded in the PR): it is built from the Panel's
 * existing dialog, settings row and toggle, whose toggle the same two options use in Settings → Integrations.
 *
 * Presentational: useWelcomeStep, owned by App, holds the state and the IPC (ADR-033 item 2). The option labels are
 * the approved ones; every other string is a `⟦COPY NEEDED⟧` marker from the copy dictionary.
 */
import { computed, ref, watch } from 'vue'
import { formatList, t, type IntegrationId, type PlainCopyKey } from '@dwarfai/contracts'
import ModalDialog from '../overlay/ModalDialog.vue'
import SettingsRow from '../panel/SettingsRow.vue'
import ToggleSwitch from '../controls/ToggleSwitch.vue'
import type { DialogAction } from '../../lib/overlay/dialog'
import type { WelcomeFailure, WelcomeOption, WelcomeTicks } from '../../composables/useWelcomeStep'

const props = defineProps<{
  /** Whether the step is drawn: while it is due, or while an answer's failures wait to be read. */
  shown: boolean
  due: boolean
  options: WelcomeOption[]
  failures: WelcomeFailure[]
  answering: boolean
}>()
const emit = defineEmits<{ activate: [ticks: WelcomeTicks]; acknowledge: [] }>()

const LABELS: Record<IntegrationId, PlainCopyKey> = {
  'claude-hooks': 'welcome.option.claudeHooks',
  'opencode-permissions': 'welcome.option.openCodePermissions'
}

/** The ticks as the person left them; every offered option starts as the Host offered it (pre-selected). */
const ticks = ref<WelcomeTicks>({})
watch(
  () => props.options,
  (options) => {
    ticks.value = Object.fromEntries(options.map((option) => [option.id, option.ticked]))
  },
  { immediate: true }
)

const failureLine = computed(() =>
  props.failures.length === 0
    ? null
    : t('welcome.result.failure', {
        names: formatList(props.failures.map((failure) => t(LABELS[failure.id])))
      })
)

const actions = computed<DialogAction[]>(() =>
  props.due
    ? [{ label: t('welcome.step.activate'), variant: 'primary', disabled: props.answering }]
    : [{ label: t('welcome.result.dismiss') }]
)

function act(): void {
  if (!props.due) {
    emit('acknowledge')
    return
  }
  if (props.answering) return
  emit('activate', { ...ticks.value })
}

/** Esc: the step is not closed and nothing is answered (US-SET-012.AC06). */
function stay(): void {}
</script>

<template>
  <ModalDialog
    :open="shown"
    :title="t('welcome.step.title')"
    :actions="actions"
    @action="act"
    @cancel="stay"
  >
    <p v-if="due" class="welcome-step__body">{{ t('welcome.step.body') }}</p>
    <div v-if="due" class="welcome-step__options">
      <SettingsRow v-for="option in options" :key="option.id" :label="t(LABELS[option.id])">
        <ToggleSwitch
          :label="t(LABELS[option.id])"
          :on="ticks[option.id] === true"
          @update:on="ticks = { ...ticks, [option.id]: $event }"
        />
      </SettingsRow>
    </div>
    <p v-if="failureLine !== null" class="welcome-step__failure" role="alert">
      {{ failureLine }}
    </p>
  </ModalDialog>
</template>

<style scoped>
.welcome-step__options {
  display: grid;
}
.welcome-step__failure {
  /* The error line's colour of Settings → Integrations (OpenCodeSettings.vue `.plugin-error`). */
  color: var(--danger-hi);
}
</style>
