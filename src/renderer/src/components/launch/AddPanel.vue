<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { belongsToComposition } from '../../lib/controls/input'
import { useHoverTip } from '../../composables/useHoverTip'
import { addPanelSelects, addPanelWhy, supplierLabel } from '../../lib/launch/addPanelCopy'
import { jevCardEyebrow, jevCardTip, jevPickText } from '../../lib/launch/jevCardCopy'
import { jevFallbackReasonWords, launchFailureNotice } from '../../lib/launch/launchFailure'
import {
  OTHER_CHOICE,
  type JevState,
  type LaunchChoice,
  type LaunchFailure,
  type LaunchPermissionMode,
  type LaunchPhase
} from '../../lib/launch/launchState'
import type { EffortPicker, ModelPicker } from '../../lib/launch/modelTuning'
import type { ProviderChip } from '../../lib/launch/providerChips'
import { isCodexPermissionMode, isHeldPermissionMode } from '../../types'
import ActionButton from '../controls/ActionButton.vue'
import ChoiceChip from '../controls/ChoiceChip.vue'
import InputField from '../controls/InputField.vue'
import SelectField from '../controls/SelectField.vue'
import ToggleSwitch from '../controls/ToggleSwitch.vue'
import PixelIcon from '../icon/PixelIcon.vue'
import TooltipCard from '../overlay/TooltipCard.vue'

/**
 * The redesigned Add panel (#635), `organisms/add-panel` in the design: the surface the mine's
 * Add action opens in the dock's window slot, where a supplier (or Jev) is chosen and the new
 * dwarf's first prompt is written, and "Send the dwarf in" launches it. Launching turns it into
 * that dwarf's MessagePanel in the same anchored place.
 *
 * Thin, like every component here. It decides nothing: which chips exist and in which state is
 * lib/launch/providerChips', whether a launch may go is lib/launch/launchState's, and every word
 * the panel says about where it stands is lib/launch/addPanelCopy's. This file turns those
 * answers into the design's parts and reports gestures back.
 *
 * ## What the redesign took away, stated rather than passing unseen
 *
 * The spawning view — the chips and the prompt replaced by the submitted prompt as a bubble —
 * is gone: the panel stays as it is while the dwarf is sent in, with Send the dwarf in disabled
 * and "Sending the dwarf in…" beside it, until its MessagePanel takes the slot. Enter no longer
 * launches from the prompt, which is a four-row field that takes line breaks: Ctrl+Enter (Cmd+Enter
 * on a Mac) does, as the design's accessibility row says, beside the button.
 */

const props = defineProps<{
  /** The mine the panel adds a dwarf to, as its title and its Ready line name it. */
  mineName: string
  chips: ProviderChip[]
  phase: LaunchPhase
  /** Whether the gate in front of the launch is open: a valid supplier, or Jev standing in. */
  enabled: boolean
  command: string
  prompt: string
  /** Why the chosen chip cannot start a session, or null. */
  refusal: string | null
  /** The reason main gave for refusing the last launch, or null. */
  error: string | null
  /** The tuning row (#239): what the model select should draw. */
  modelPicker: ModelPicker
  /** What the effort select should draw — hidden when the chosen provider has none. */
  effortPicker: EffortPicker
  /** Whether the Permissions select holds values — held Claude and, since #635, Codex. */
  permissionsVisible: boolean
  /** The Jev option (#509): availability, the person's toggle, and where a routed launch is. */
  jev: JevState
  /**
   * What the launch model holds for the three selects, which they show (#635). Vue sets a bound
   * value again on every render, so a select drawn without these snapped each pick back to its
   * first option (the PO's report, 2026-09-28), and Jev's pick, which sets them without touching
   * the controls, never showed at all (MESSAGE-QUESTIONS 2). Absent, a select shows its first.
   */
  model?: string | null
  effort?: string | null
  permissionMode?: LaunchPermissionMode | null
  /** Why the last launch failed, for the launch-failure notice (#635), or null. */
  failure?: LaunchFailure | null
}>()

const emit = defineEmits<{
  choose: [choice: LaunchChoice]
  /** The custom-command box's text, as it is typed. */
  command: [text: string]
  /** Enter in the custom-command box. */
  commit: []
  /** The prompt's text, as it is typed. */
  prompt: [text: string]
  /** A model picked off the tuning row. */
  model: [value: string]
  effort: [value: string]
  permissionMode: [value: LaunchPermissionMode]
  /** The Jev toggle (#509). */
  'toggle-jev': []
  /** The #523 auto-accept switch beside it. */
  'toggle-jev-auto': []
  /** The decision card's own Dismiss control (#509). */
  'dismiss-jev': []
  submit: []
  /** The launch-failure notice's Retry (#635): the same launch, again. */
  retry: []
  /** Its Pick manually (#635): Let Jev choose off, so the chips and selects choose. */
  'pick-manually': []
  close: []
}>()

const spawning = computed(() => props.phase === 'submitted-spawning')
/**
 * A launch that started and that this panel is not holding (#168, #191): its dwarf is recognised
 * only once main proves it from the session's own transcript, which the line beside the button
 * promises and nothing more.
 */
const detached = computed(() => props.phase === 'started-detached')
/** Both end states hold the panel as it is, with nothing left to press but Close. */
const launched = computed(() => spawning.value || detached.value)

const chosen = computed(() => props.chips.find((chip) => chip.state === 'selected')?.choice ?? null)
const showCommand = computed(() => chosen.value === OTHER_CHOICE)
const jevOn = computed(() => props.jev.availability === 'ready' && props.jev.enabled)

/**
 * A command typed under Other… but not yet committed with its Enter (#635). The panel this one
 * replaced kept its prompt disabled until that Enter, so nobody could reach a launch without it;
 * this one lets the prompt be written first, and a person who typed a command and moved on has
 * chosen their supplier. So the command in the box counts as committed, and launching commits it
 * first — the launch model's own gate still decides, on the same committed command as before.
 */
const commandPending = computed(
  () => showCommand.value && !props.enabled && props.command.trim() !== ''
)
/** The gate as this panel reads it: the launch model's, or Other… with a command in its box. */
const supplierReady = computed(() => props.enabled || commandPending.value)

/**
 * The launch-failure notice (#635; components.md, Add a dwarf): the cause, what to do, and the
 * actions that cause has. Its words and which actions it offers are lib/launch/launchFailure's.
 */
const notice = computed(() =>
  props.failure === null || props.failure === undefined ? null : launchFailureNotice(props.failure)
)
/** A Jev cause is the notice saying what Jev did, so the fallback line under the toggles steps aside. */
const jevFailed = computed(
  () =>
    props.failure?.cause === 'jev-unreachable' || props.failure?.cause === 'jev-could-not-choose'
)

/** The line beside Send the dwarf in, and whether it is an alert. */
const why = computed(() =>
  addPanelWhy({
    phase: props.phase,
    enabled: supplierReady.value,
    prompt: props.prompt,
    refusal: props.refusal,
    error: props.error,
    mineName: props.mineName,
    jevAsking: props.jev.routing.phase === 'asking',
    failed: notice.value !== null
  })
)

/** The one row of selects: Model, Effort and Permissions. */
const selects = computed(() =>
  addPanelSelects({
    choice: chosen.value,
    jevOn: jevOn.value,
    modelPicker: props.modelPicker,
    effortPicker: props.effortPicker,
    permissionsVisible: props.permissionsVisible,
    values: {
      model: props.model ?? null,
      effort: props.effort ?? null,
      permissionMode: props.permissionMode ?? null
    }
  })
)

/** Send the dwarf in wakes once a supplier is valid (or Jev is on) and there is a prompt. */
const canLaunch = computed(
  () =>
    supplierReady.value &&
    !launched.value &&
    props.jev.routing.phase !== 'asking' &&
    props.prompt.trim() !== ''
)

function launch(): void {
  if (!canLaunch.value) return
  if (commandPending.value) emit('commit')
  emit('submit')
}

/**
 * Ctrl+Enter (Cmd+Enter on a Mac) launches from the prompt when ready (components.md, Add a
 * dwarf, Accessibility). Either modifier on every platform: the person's own habit is the one
 * that should work, and neither does anything else in a text field. Plain Enter is a line break.
 */
function onPromptKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)) return
  // An input method's own Enter picks its candidate; the text is not written yet (#635).
  if (belongsToComposition(event)) return
  event.preventDefault()
  launch()
}

/** Enter commits the command (#194), unless it is the input method's own (#635). */
function onCommandKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || belongsToComposition(event)) return
  event.preventDefault()
  emit('commit')
}

/*
 * The panel takes the keyboard when it opens, on its first control: the first supplier chip
 * (screens/shell.md, Where focus goes, `focusFirst()`). Once Vue has drawn it, as the
 * MessagePanel does its composer (#409); the dock remounts the panel for every opening.
 */
const chipRow = ref<HTMLElement | null>(null)
function focusFirstChip(): void {
  chipRow.value?.querySelector<HTMLElement>('button:not([disabled])')?.focus()
}
onMounted(async () => {
  await nextTick()
  focusFirstChip()
})

/*
 * Pick manually hands the keyboard to the first supplier chip (screens/launch.md, As built): the
 * chips and the three selects take over from Jev, and the notice leaves with the pressed button.
 * Once Vue has redrawn the panel without it.
 */
async function pickManually(): Promise<void> {
  emit('pick-manually')
  await nextTick()
  focusFirstChip()
}

/** A pick off one of the three selects, reported to the launch model under its own name. */
function pick(label: 'Model' | 'Effort' | 'Permissions', value: string): void {
  if (label === 'Model') emit('model', value)
  else if (label === 'Effort') emit('effort', value)
  // Held Claude's modes or Codex's (#635); the list the select drew is the chosen supplier's own.
  else if (isHeldPermissionMode(value) || isCodexPermissionMode(value)) {
    emit('permissionMode', value)
  }
}

/** The no-key reason, in the words the Jev fallback line already uses for it (#509). */
const JEV_NO_KEY = 'No TypeSafe key is set'

/*
 * Jev (#509): a toggle beside the pickers it can fill in for, a decision
 * card once it has, and a fallback line when it could not. Nothing here
 * decides whether Jev SHOULD be asked or what its answer means — `jev` is
 * already `launchState`'s own resolved reading; this only turns it into
 * text and controls.
 */

/** Duplicated from JevSettings.vue's own `UNAVAILABLE_MESSAGES` deliberately — the same reason main gave, in main's own words, wherever the option is explained. */
const JEV_UNAVAILABLE_MESSAGES: Record<NonNullable<JevState['unavailableReason']>, string> = {
  'encryption-unavailable':
    'This machine offers no encrypted place to keep a key, so Jev cannot be turned on here.'
}

const jevUnavailableMessage = computed(() => {
  const reason = props.jev.unavailableReason
  return reason === undefined ? '' : JEV_UNAVAILABLE_MESSAGES[reason]
})

const jevDecision = computed(() =>
  props.jev.routing.phase === 'decided' ? props.jev.routing.decision : null
)

/**
 * The decision card stays on screen while the launch is in flight, so the panel stays as it is
 * (MESSAGE-QUESTIONS Q1, design lead ruling 2026-09-28): what goes out is still what it names.
 * Its Dismiss waits with every other control instead, because putting the pickers back under a
 * launch already going would make the card name a launch that is not the one under way.
 */
const showJevDecision = computed(() => jevDecision.value !== null)

/*
 * Dismiss hands the keyboard to Let Jev choose (components.md, Add a dwarf, Accessibility): the
 * card takes the pressed button away with it, and the toggle is what brings the card back.
 */
const jevToggle = ref<InstanceType<typeof ToggleSwitch> | null>(null)
function dismissJev(): void {
  emit('dismiss-jev')
  ;(jevToggle.value?.$el as HTMLElement | undefined)?.focus()
}

/**
 * The supplier as the chip row draws it, off the SAME chip — the tool's own name, never the CLI
 * binary name; the raw id only for a provider no chip stands for.
 */
const jevProviderLabel = computed(() => {
  const decision = jevDecision.value
  if (decision === null) return ''
  const chip = props.chips.find((entry) => entry.choice === decision.provider)
  return chip === undefined ? decision.provider : supplierLabel(chip.choice)
})

/** The model's label off the picker's own catalogue, falling back to the raw id it could not resolve. */
const jevModelLabel = computed(() => {
  const decision = jevDecision.value
  if (decision === null || decision.model === undefined) return null
  return (
    props.modelPicker.models.find((option) => option.value === decision.model)?.label ??
    decision.model
  )
})

/*
 * The card (MESSAGE-QUESTIONS 15; decision log, Jev card from the decision): the eyebrow, Jev's
 * pick in bold, and Dismiss. Everything else the decision says is in the pick's tooltip, one
 * sentence per line, on hover after the tooltip delay and at once on keyboard focus, below the
 * paragraph and aligned to its start, as the outcome line's (useHoverTip). A hidden copy of the
 * same lines describes the paragraph for a screen reader. The #509 closing note is gone: the
 * pickers show the pick themselves.
 */
const jevEyebrow = computed(() => jevCardEyebrow(props.jev.autoAccept))
const jevPick = computed(() => {
  const decision = jevDecision.value
  if (decision === null) return ''
  return jevPickText({
    supplier: jevProviderLabel.value,
    model: jevModelLabel.value,
    ...(decision.effort === undefined ? {} : { effort: decision.effort })
  })
})
const jevTipLines = computed(() => {
  const decision = jevDecision.value
  return decision === null ? [] : jevCardTip(decision, jevProviderLabel.value)
})
const jevTip = useHoverTip<'pick'>({ side: 'bottom', align: 'start' })
const jevTipId = 'dm-add-jev-tip-' + ++cards

/*
 * The fallback line says every way Jev failed still launched, or what is owed instead (#509,
 * #523). Its reason words are the app's own, now in lib/launch/launchFailure, which the
 * launch-failure notice's "Jev could not choose" opens with too (#635).
 */
const jevFallbackMessage = computed(() => {
  const routing = props.jev.routing
  if (routing.phase !== 'fellBack') return ''
  const withConfidence = jevFallbackReasonWords(routing.reason, routing.confidence)

  // jev-routing-profiles T4: a configured default was just applied to the
  // pickers below (launchState.jevAnswered's own detour), so this line says
  // so and asks for the confirming Enter, rather than the #509/#523 ending
  // below — which only ever describes the CURRENT chips and would be wrong
  // here, since those chips are exactly what this default just set.
  if (routing.appliedDefault !== undefined) {
    const appliedDefault = routing.appliedDefault
    const providerLabel =
      props.chips.find((chip) => chip.choice === appliedDefault.provider)?.label ??
      appliedDefault.provider
    const modelLabel =
      appliedDefault.model === undefined
        ? null
        : (props.modelPicker.models.find((option) => option.value === appliedDefault.model)
            ?.label ?? appliedDefault.model)
    const pieces = [providerLabel]
    if (modelLabel !== null) pieces.push(modelLabel)
    if (appliedDefault.effort !== undefined) pieces.push(appliedDefault.effort)
    return `Jev could not decide (${withConfidence}). Your default, ${pieces.join(' · ')}, is set below — press Launch again or change it.`
  }

  // The ending is `launchState`'s fact — `launchedOnFallback`, recorded at
  // the moment the answer landed — never a reading of the current chips: a
  // chip clicked afterwards must not rewrite whether this fallback launched.
  const ending = props.jev.launchedOnFallback
    ? "Launched with your pickers' values."
    : 'Your prompt was kept — choose a provider to launch.'
  return `${withConfidence}. ${ending}`
})

/** Why the Jev switches cannot be pressed: no key yet, or the reason main gave (#509). */
const jevUnavailableTitle = computed(() =>
  props.jev.availability === 'hidden' ? JEV_NO_KEY : jevUnavailableMessage.value
)
</script>

<script lang="ts">
/** Every panel's own number, for the id its Jev tooltip's hidden copy is named by. */
let cards = 0
</script>

<template>
  <section
    class="dm-add m-mat m-wood m-raised"
    role="dialog"
    :aria-label="`Add a dwarf to ${mineName}`"
    @keydown.escape="emit('close')"
    @click.stop
  >
    <!-- Anchored like the MessagePanel (#635): the header does not drag. -->
    <header class="dm-add__head">
      <PixelIcon name="add" :scale="2" />
      <h2 class="dm-add__title">
        Add a dwarf
        <small>to {{ mineName }}</small>
      </h2>
      <ActionButton
        class="dm-add__close"
        icon="close"
        size="sm"
        title="Close"
        @click="emit('close')"
      />
    </header>

    <div class="dm-add__body">
      <!--
        The supplier chips (W7·1), detected providers then Other… for a command of the person's
        own, which opens its field under them. Enter commits the command (#194): the gate behind it
        decides whether the launch can go.
      -->
      <div class="dm-add__sec">
        <p class="dm-add__label">Choose your dwarf supplier</p>
        <div ref="chipRow" class="dm-add__chips" role="radiogroup" aria-label="Supplier">
          <ChoiceChip
            v-for="chip in chips"
            :key="chip.choice"
            role="radio"
            :label="supplierLabel(chip.choice)"
            :pressed="chip.state === 'selected'"
            :data-value="chip.choice"
            :disabled="launched"
            @click="emit('choose', chip.choice)"
          />
        </div>
        <InputField
          :hidden="!showCommand"
          class="dm-add__command"
          placeholder="Custom command, e.g. my-agent --yes"
          label="Custom command"
          :value="command"
          :disabled="launched"
          @update:value="emit('command', $event)"
          @keydown="onCommandKeydown"
        />
      </div>

      <!--
        Jev (W7·2, #509): the toggle and auto-accept, with its decision or fallback below once it
        has answered. Drawn in every state as the design draws it; a Jev that cannot be asked — no
        key, or main's own reason (#509) — shows both switches off and disabled, with that reason
        on them.
      -->
      <div class="dm-add__sec">
        <p class="dm-add__label">Jev</p>
        <div class="dm-add__row">
          <span class="t-section">Let Jev choose</span>
          <ToggleSwitch
            ref="jevToggle"
            label="Let Jev choose"
            :on="jev.enabled"
            :disabled="jev.availability !== 'ready' || launched"
            :title="jev.availability === 'ready' ? undefined : jevUnavailableTitle"
            held
            @update:on="emit('toggle-jev')"
          />
          <span class="t-meta t-soft">Auto-accept</span>
          <ToggleSwitch
            label="Auto-accept Jev"
            :on="jev.autoAccept"
            :disabled="jev.availability !== 'ready' || launched"
            :title="jev.availability === 'ready' ? undefined : jevUnavailableTitle"
            held
            @update:on="emit('toggle-jev-auto')"
          />
        </div>
        <!--
          The decision card (#509): shown before it is acted on, and can be overridden — the
          pickers below have already been set to it, so Dismiss puts them back rather than this
          card undoing anything itself. Its shape is the design's (MESSAGE-QUESTIONS 15). The
          fallback line says every way Jev failed still launched, or what is owed instead (#523).
        -->
        <div v-if="showJevDecision && jevDecision !== null" class="dm-add__jev" role="status">
          <span class="t-meta">{{ jevEyebrow }}</span>
          <p
            class="dm-add__jev-pick"
            tabindex="0"
            :aria-describedby="jevTipId"
            @pointerenter="jevTip.hover('pick', $event)"
            @pointerleave="jevTip.leave"
            @pointerdown="jevTip.press"
            @focus="jevTip.focus('pick', $event)"
            @blur="jevTip.hide"
          >
            <b>{{ jevPick }}</b
            >.
          </p>
          <span :id="jevTipId" class="sr-only">{{ jevTipLines.join(' ') }}</span>
          <div class="dm-add__jev-actions">
            <ActionButton
              class="jev-dismiss"
              label="Dismiss"
              size="sm"
              :disabled="launched"
              @click="dismissJev"
            />
          </div>
          <!-- In <body>: the panel's body scrolls, which would otherwise clip a fixed card. -->
          <Teleport to="body">
            <Transition name="dm-tip-pop">
              <TooltipCard
                v-if="jevTip.shown.value !== null"
                :ref="jevTip.card"
                :style="jevTip.style.value"
                ><div v-for="line in jevTipLines" :key="line">{{ line }}</div></TooltipCard
              >
            </Transition>
          </Teleport>
        </div>
        <div
          v-else-if="jev.routing.phase === 'fellBack' && !jevFailed"
          class="dm-add__jev"
          role="status"
        >
          <p class="jev-fallback">{{ jevFallbackMessage }}</p>
          <!--
            Only when a default was APPLIED: the pickers below were overwritten exactly as a
            decision would overwrite them, so the same Dismiss belongs here too.
          -->
          <ActionButton
            v-if="jev.routing.appliedDefault !== undefined"
            class="jev-dismiss jev-fallback-dismiss"
            label="Dismiss"
            size="sm"
            :disabled="launched"
            @click="dismissJev"
          />
        </div>
      </div>

      <!--
        Model, effort and permissions as one row of selects (W7·3), which wraps a select onto the
        next line rather than cut its label. What the model list could not say (#239) — no live
        list, or where the list came from — is a line under the row.
      -->
      <div class="dm-add__sec">
        <p class="dm-add__label">Model, effort and permissions</p>
        <div class="dm-add__row">
          <SelectField
            v-for="select in selects"
            :key="select.label"
            :label="select.label"
            :options="select.options"
            :value="select.value"
            :disabled="select.disabled || launched"
            @update:value="pick(select.label, $event)"
          />
        </div>
        <p v-if="modelPicker.visible && modelPicker.note" class="dm-add__note">
          {{ modelPicker.note }}
        </p>
      </div>

      <!--
        The prompt (W7·4). No maxlength since #431: this prompt never travels through a command
        line, so there is no ceiling to state and nothing for the panel to refuse.
      -->
      <div class="dm-add__sec">
        <p class="dm-add__label">Prompt</p>
        <InputField
          class="dm-add__prompt"
          area
          :rows="4"
          placeholder="What should this dwarf work on?"
          label="Prompt"
          :value="prompt"
          :disabled="launched"
          @update:value="emit('prompt', $event)"
          @keydown="onPromptKeydown"
        />
      </div>
    </div>

    <!--
      The footer (W7·5): after a failed launch, the danger notice above Send the dwarf in, so it is
      on screen however far the body scrolls (#635): the warning icon, the cause, what to do, then
      its actions. An alert, so its cause is read out when it appears; focus stays where it was.
      Then the line that says where the launch stands — main's own words for a failure it named no
      cause for — and the launch itself.
    -->
    <footer class="dm-add__foot">
      <div v-if="notice !== null" class="dm-add__fail" role="alert" :data-cause="failure?.cause">
        <PixelIcon name="warning" />
        <div class="dm-add__fail-body">
          <p class="dm-add__fail-title">{{ notice.title }}</p>
          <p class="dm-add__fail-text">{{ notice.text }}</p>
          <!--
            Drawn even with no action to hold, as the design draws it: with no launchable provider
            the row is empty, and its margin is still part of the notice's height.
          -->
          <div class="dm-add__fail-actions">
            <ActionButton
              v-if="notice.retry"
              class="dm-add__fail-retry"
              label="Retry"
              :disabled="launched"
              @click="emit('retry')"
            />
            <ActionButton
              v-if="notice.pickManually"
              class="dm-add__fail-manual"
              label="Pick manually"
              :disabled="launched"
              @click="pickManually"
            />
          </div>
        </div>
      </div>
      <p class="dm-add__why" :class="{ 'is-alert': why.tone === 'alert' }" :role="why.tone">
        {{ why.text }}
      </p>
      <ActionButton
        class="dm-add__launch"
        variant="primary"
        size="lg"
        label="Send the dwarf in"
        :disabled="!canLaunch"
        @click="launch"
      />
    </footer>
  </section>
</template>

<style scoped>
/* The design's add-panel.css, rule for rule. */
.dm-add {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  width: 440px;
  max-width: 100%;
  height: 100%;
  min-height: 0;
  text-align: left;
}
.dm-add__head {
  display: flex;
  gap: 8px;
  padding: 8px 4px 8px 10px;
  background: var(--wood-lo);
  box-shadow: inset 0 -2px 0 0 var(--rock-lo);
  align-items: center;
}
.dm-add__title {
  flex: 1;
  min-width: 0;
  margin: 0;
  font: var(--fs-title) / 1.05 var(--f-display);
  color: var(--gold);
}
.dm-add__title small {
  display: block;
  margin-top: 4px;
  font-size: var(--fs-meta);
  color: var(--ink-soft);
}
.dm-add__body {
  display: grid;
  gap: 14px;
  padding: 12px 10px;
  align-content: start;
  overflow-y: auto;
}
.dm-add__sec {
  display: grid;
  gap: 6px;
}
.dm-add__label {
  margin: 0;
  font: var(--fs-meta) / 1 var(--f-meta);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ink-faint);
}
.dm-add__chips {
  display: flex;
  gap: 0 2px;
  flex-wrap: wrap;
}
.dm-add__row {
  display: flex;
  gap: 4px 14px;
  flex-wrap: wrap;
  align-items: center;
}
.dm-add__row :deep(.dm-select) {
  flex: 1 1 auto;
}
.dm-add__jev {
  display: grid;
  gap: 6px;
  padding: 8px 10px;
  margin: 2px;
  font: var(--fs-body) / 1.35 var(--f-talk);
  color: var(--ink);
  background: var(--info-lo);
  box-shadow:
    0 -2px 0 0 var(--info),
    0 2px 0 0 var(--info),
    -2px 0 0 0 var(--info),
    2px 0 0 0 var(--info);
}
.dm-add__jev p {
  margin: 0;
}
.dm-add__jev b {
  color: var(--parch-hi);
}
.dm-add__jev .t-meta {
  color: var(--info);
}
.dm-add__jev-actions {
  display: flex;
}
.dm-add__foot {
  display: flex;
  gap: 8px;
  padding: 8px;
  background: var(--wood);
  box-shadow: inset 0 2px 0 0 var(--wood-hi);
  flex-wrap: wrap;
  justify-content: flex-end;
  align-items: center;
}
/* Launch failure: the settings danger zone's surface and type, as a full-width row above the launch. */
.dm-add__fail {
  flex: 1 1 100%;
  display: flex;
  gap: 8px;
  padding: 10px;
  margin: 2px;
  background: var(--danger-lo);
  box-shadow:
    0 -2px 0 0 var(--danger),
    0 2px 0 0 var(--danger),
    -2px 0 0 0 var(--danger),
    2px 0 0 0 var(--danger);
  align-items: flex-start;
}
.dm-add__fail-body {
  display: grid;
  min-width: 0;
  gap: 4px;
}
.dm-add__fail-title {
  margin: 0;
  font: var(--fs-section) / 1.2 var(--f-label);
  color: var(--danger-hi);
}
.dm-add__fail-text {
  margin: 0;
  font: var(--fs-meta) / 1.35 var(--f-meta);
  color: var(--ink-soft);
}
.dm-add__fail-actions {
  display: flex;
  gap: 4px;
  margin-top: 4px;
  flex-wrap: wrap;
}
.dm-add__why {
  flex: 1;
  margin: 0;
  font: var(--fs-meta) / 1.3 var(--f-meta);
  color: var(--ink-faint);
}
/* A refused launch says why in the danger ink the dark ground reads (tokens: --danger-hi). */
.dm-add__why.is-alert {
  color: var(--danger-hi);
}
/* What the model list could not say, under the row, in the note face. */
.dm-add__note {
  margin: 0;
  font: var(--fs-meta) / 1.3 var(--f-meta);
  color: var(--ink-faint);
}
</style>
