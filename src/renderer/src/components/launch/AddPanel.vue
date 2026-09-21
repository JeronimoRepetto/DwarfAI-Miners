<script setup lang="ts">
import { computed } from 'vue'
import { CLOSE_ICON_SRC, USER_PORTRAIT_SRC, maskImageValue } from '../../lib/art'
import {
  COMMAND_PLACEHOLDER,
  COMPOSER_DISABLED_PLACEHOLDER,
  OTHER_CHOICE,
  type JevState,
  type LaunchChoice,
  type LaunchPhase
} from '../../lib/launch/launchState'
import type { EffortPicker, ModelPicker } from '../../lib/launch/modelTuning'
import type { ProviderChip } from '../../lib/launch/providerChips'
import {
  HELD_PERMISSION_MODES,
  type HeldPermissionMode,
  type JevFallbackReason,
  type ModelTier
} from '../../types'

/**
 * The design's Add Panel (#86): the surface the mine's Add action opens, where
 * a provider is chosen and the new agent's first prompt is written.
 *
 * It shares the MessagePanel's dock and its visual language on purpose — the
 * source says it is visually similar, and submitting REPLACES it with that
 * panel, so the two have to look like one surface changing rather than two
 * surfaces swapping. What is different is everything above the composer: a chip
 * row, and a gate.
 *
 * Thin, like every component here. It decides nothing: which chips exist and in
 * which state is lib/launch/providerChips', whether the composer is open is
 * lib/launch/launchState's, and what a launch costs is the composable's. This
 * file turns those answers into the design's own boxes and reports gestures
 * back.
 *
 * ## The panel title is the instruction
 *
 * The source's own export puts `Select your Dwarf supplier` in the title bar
 * AND in the disabled composer, and it stays in the title after a choice is
 * made. That is the screen's name, not a live status line — so it is written
 * once, as the panel's accessible name and its heading.
 */

const props = defineProps<{
  chips: ProviderChip[]
  phase: LaunchPhase
  /** Whether the gate in front of the composer is open. */
  enabled: boolean
  placeholder: string
  command: string
  prompt: string
  /** Why the chosen chip cannot start a session, or null. */
  refusal: string | null
  /** The reason main gave for refusing the last launch, or null. */
  error: string | null
  /** The row under the composer (#239): what the model select should draw. */
  modelPicker: ModelPicker
  /** What the effort select should draw — hidden when the chosen provider has none. */
  effortPicker: EffortPicker
  /** Whether the Permissions select belongs on screen — held Claude only. */
  permissionsVisible: boolean
  /** The Jev option (#509): availability, the person's toggle, and where a routed launch is. */
  jev: JevState
}>()

const emit = defineEmits<{
  choose: [choice: LaunchChoice]
  /** The custom-command box's text, as it is typed. */
  command: [text: string]
  /** Enter in the custom-command box. */
  commit: []
  /** The composer's text, as it is typed. */
  prompt: [text: string]
  /** A model picked off the row under the composer. */
  model: [value: string]
  effort: [value: string]
  permissionMode: [value: HeldPermissionMode]
  /** The Jev toggle (#509). */
  'toggle-jev': []
  /** The #523 auto-accept checkbox beside it. */
  'toggle-jev-auto': []
  /** The decision card's own Dismiss control (#509). */
  'dismiss-jev': []
  submit: []
  close: []
}>()

const spawning = computed(() => props.phase === 'submitted-spawning')
/**
 * A launch that started and that this panel is not holding (#168, #191).
 *
 * Drawn like the spawning view — the chips and the composer go, the submitted
 * prompt stays — but its note says something different, because what the panel
 * is waiting for is different. A detached session leaves no held conversation,
 * so it cannot be recognised by its words the way a held one is; it is
 * recognised when main proves it from the session's own transcript, which is a
 * thing that can take a sweep or two and, on a provider whose store says
 * nothing, may not happen at all. The copy below promises only that.
 */
const detached = computed(() => props.phase === 'started-detached')
/** Both end states replace the Add controls with the prompt that was sent. */
const launched = computed(() => spawning.value || detached.value)
const showCommand = computed(() =>
  props.chips.some((chip) => chip.choice === OTHER_CHOICE && chip.state === 'selected')
)

/**
 * Enter submits, Shift+Enter writes a newline — the convention every composer
 * here uses, and the one the source states for this one.
 *
 * The disabled attribute already stops a keystroke reaching a closed gate;
 * checking again costs nothing and means the rule does not depend on the
 * browser honouring it. A second guard blocks it while Jev is being asked
 * (#509) — the "submit control disabled" state the source's own amendment
 * asks for, since this composer draws no separate submit button for Enter
 * to disable.
 */
function onPromptKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || event.shiftKey) return
  event.preventDefault()
  if (!props.enabled || props.jev.routing.phase === 'asking') return
  emit('submit')
}

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

/** The provider's label off the SAME source the chip row already resolved it from — never the CLI binary name. */
const jevProviderLabel = computed(() => {
  const decision = jevDecision.value
  if (decision === null) return ''
  return props.chips.find((chip) => chip.choice === decision.provider)?.label ?? decision.provider
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

const jevConfidencePercent = computed(() => {
  const decision = jevDecision.value
  return decision === null ? 0 : Math.round(decision.confidence * 100)
})

/** The one sentence the card states Jev chose, provider/model/effort/confidence together. */
const jevDecisionSummary = computed(() => {
  const decision = jevDecision.value
  if (decision === null) return ''
  const parts = [jevProviderLabel.value]
  if (jevModelLabel.value !== null) parts.push(jevModelLabel.value)
  if (decision.effort !== undefined) parts.push(`${decision.effort} effort`)
  return `Jev chose ${parts.join(', ')} (${jevConfidencePercent.value}% confidence).`
})

/**
 * The tier in words (jev-routing-profiles T4) — `ModelTier`'s own kebab-case
 * wire values are never shown as-is. `'special-purpose'` is exhaustive
 * against the type only: a routing decision never lands on it (see
 * `ModelTier`'s own comment in contracts.ts), so this card never renders it.
 */
const TIER_LABELS: Record<ModelTier, string> = {
  'fast-cheap': 'fast & cheap',
  balanced: 'balanced',
  frontier: 'frontier',
  'long-context': 'long context',
  'special-purpose': 'special purpose'
}

/**
 * Which parts Jev itself answered confidently, and which fell to a safe
 * value instead (jev-routing-profiles T4) — `JevRouteParts`' own two
 * confidence-bearing parts, `provider` and `tier`. Confidence is always
 * Jev's OWN raw reported number even for a part that fell back — see
 * `JevRouteAnsweredPart`'s own comment in contracts.ts — so this line can
 * say how close it was, not just that a floor bit. Whether the safe value
 * came from the person's own configured default or the cheapest launchable
 * provider is not on the wire (`applied` only ever says 'safe-default'), so
 * this deliberately says "the safe value" rather than guessing "your
 * default" for a part that might not be.
 */
const jevPartsSummary = computed(() => {
  const decision = jevDecision.value
  if (decision === null) return ''
  const tierPct = Math.round(decision.parts.tier.confidence * 100)
  const providerPct = Math.round(decision.parts.provider.confidence * 100)
  const tierLabel = TIER_LABELS[decision.tier]

  const chosen: string[] = []
  if (decision.parts.tier.applied === 'answered') {
    chosen.push(`the ${tierLabel} tier (${tierPct}% sure)`)
  }
  if (decision.parts.provider.applied === 'answered') {
    chosen.push(`${jevProviderLabel.value} (${providerPct}% sure)`)
  }

  const unsureNames: string[] = []
  const unsureValues: string[] = []
  if (decision.parts.tier.applied === 'safe-default') {
    unsureNames.push(`the tier (${tierPct}%)`)
    unsureValues.push(tierLabel)
  }
  if (decision.parts.provider.applied === 'safe-default') {
    unsureNames.push(`the provider (${providerPct}%)`)
    unsureValues.push(jevProviderLabel.value)
  }

  let sentence = chosen.length === 0 ? '' : `Jev chose ${chosen.join(' and ')}.`
  if (unsureNames.length > 0) {
    const plural = unsureValues.length > 1
    const unsureSentence = `Jev was unsure about ${unsureNames.join(' and ')}; the safe value${
      plural ? 's' : ''
    } ${unsureValues.join(' and ')} ${plural ? 'were' : 'was'} used.`
    sentence = sentence === '' ? unsureSentence : `${sentence} ${unsureSentence}`
  }
  return sentence
})

/**
 * Fixed English sentences per fallback reason (#509's own acceptance
 * criterion: every way Jev can fail still launches and says that it did).
 * Kept here, display text only — the wire only ever carries the reason, on
 * the same split `contracts.ts` states for every prompt-sentence-that-names-
 * no-provider.
 *
 * AMENDED in the ending below for #523: “still launches” was true because a
 * chip always stood under it. On the toggle-alone entry path there may be
 * nothing to launch onto, and then the line says what IS owed instead —
 * nothing launched, the prompt stands, a provider is missing.
 */
const JEV_FALLBACK_REASONS: Record<JevFallbackReason, string> = {
  'no-key': 'No TypeSafe key is set',
  'no-launchable-provider': 'No launchable provider to choose from',
  unreachable: 'Jev could not be reached',
  timeout: 'Jev took too long',
  'rate-limited': 'Jev is rate-limited right now',
  unauthorized: 'TypeSafe rejected the API key',
  'low-confidence': 'Jev was not confident enough',
  'invalid-response': "Jev's answer could not be used",
  'budget-exceeded': "The prompt and catalogue do not fit Jev's request budget"
}

const jevFallbackMessage = computed(() => {
  const routing = props.jev.routing
  if (routing.phase !== 'fellBack') return ''
  const reason = JEV_FALLBACK_REASONS[routing.reason]
  const withConfidence =
    routing.reason === 'low-confidence' && routing.confidence !== undefined
      ? `${reason} (${Math.round(routing.confidence * 100)}%)`
      : reason

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

/** Enter commits the command. The gate behind it decides whether that opens anything. */
function onCommandKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || event.shiftKey) return
  event.preventDefault()
  emit('commit')
}
</script>

<template>
  <section
    class="add-panel"
    :aria-label="COMPOSER_DISABLED_PLACEHOLDER"
    @keydown.escape="emit('close')"
    @click.stop
  >
    <!-- The same window-drag handle the message panel's header carries (#296). -->
    <header class="panel-bar" data-window-drag>
      <h2 class="panel-title">{{ COMPOSER_DISABLED_PLACEHOLDER }}</h2>
      <button
        class="launch-close"
        type="button"
        aria-label="Close the launch panel"
        @click="emit('close')"
      >
        <span
          class="close-glyph"
          :style="{ '--close-icon': maskImageValue(CLOSE_ICON_SRC) }"
          aria-hidden="true"
        ></span>
      </button>
    </header>

    <!--
      The chip row and the command box share one line, exactly as the source's
      Other export draws them: the command appears beside the chips rather than
      under them, so choosing Other grows the row instead of moving it.
    -->
    <div v-if="!launched" class="launch-choices">
      <button
        v-for="chip in chips"
        :key="chip.choice"
        class="provider-chip"
        type="button"
        :data-state="chip.state"
        :aria-pressed="chip.state === 'selected'"
        @click="emit('choose', chip.choice)"
      >
        {{ chip.label }}
      </button>
      <input
        v-if="showCommand"
        class="launch-command is-selectable"
        type="text"
        :value="command"
        :placeholder="COMMAND_PLACEHOLDER"
        aria-label="Your own launch command"
        @input="emit('command', ($event.target as HTMLInputElement).value)"
        @keydown="onCommandKeydown"
      />
    </div>

    <!--
      `launch.md` step 3 — the submitted prompt is the conversation's first
      message — drawn here because between Enter and the dwarf's arrival there
      is no MessagePanel to hold it. It is not a copy that outlives that window:
      the moment the dwarf lands this panel is gone, and the MessagePanel draws
      main's own record of the same words (the held session was seeded with
      them), so it is shown once and by whoever can prove it.
    -->
    <div v-if="launched" class="launch-spawning">
      <article class="message is-user">
        <p class="launch-first-message bubble">{{ prompt }}</p>
        <img class="portrait" :src="USER_PORTRAIT_SRC" alt="You" draggable="false" />
      </article>
    </div>

    <template v-else>
      <!--
        No maxlength since #431. This prompt never travels through a command
        line: a detached launch writes it to the child's stdin and a held one
        passes it to the SDK inside this process, so the ceiling a MESSAGE
        answers to was never its bound (see prepareLaunchPrompt). There is
        therefore no limit to state and nothing for the panel to refuse —
        only the silent cut that used to be here.
      -->
      <textarea
        class="launch-input is-selectable"
        rows="2"
        :value="prompt"
        :disabled="!enabled"
        :placeholder="placeholder"
        :class="{ 'is-instruction': !enabled }"
        :aria-label="placeholder"
        @input="emit('prompt', ($event.target as HTMLTextAreaElement).value)"
        @keydown="onPromptKeydown"
      ></textarea>

      <!--
        The row under the composer (#239, launch.md's maintainer amendment):
        model, effort and permissions, visible once a real provider chip is
        chosen. Reuses this screen's own chip and input surfaces — nothing
        new is drawn, per the amendment's own words.
      -->
      <div v-if="modelPicker.visible" class="launch-tuning">
        <select
          class="tuning-select"
          :disabled="modelPicker.disabled"
          aria-label="Model"
          @change="emit('model', ($event.target as HTMLSelectElement).value)"
        >
          <option v-for="option in modelPicker.models" :key="option.value" :value="option.value">
            {{ option.label ?? option.value }}
          </option>
        </select>
        <span v-if="modelPicker.note" class="tuning-note">{{ modelPicker.note }}</span>
        <select
          v-if="effortPicker.visible"
          class="tuning-select"
          aria-label="Effort"
          @change="emit('effort', ($event.target as HTMLSelectElement).value)"
        >
          <option v-for="level in effortPicker.efforts" :key="level" :value="level">
            {{ level }}
          </option>
        </select>
        <select
          v-if="permissionsVisible"
          class="tuning-select"
          aria-label="Permissions"
          @change="
            emit('permissionMode', ($event.target as HTMLSelectElement).value as HeldPermissionMode)
          "
        >
          <option v-for="mode in HELD_PERMISSION_MODES" :key="mode" :value="mode">
            {{ mode }}
          </option>
        </select>
      </div>

      <!--
        Jev (#509): a toggle beside the pickers it can fill in for. Absent
        outright with no key configured — issue #509's own first option —
        shown disabled with main's reason for anything else that keeps it
        off, and pressable once ready.
      -->
      <div v-if="jev.availability !== 'hidden'" class="jev-row">
        <template v-if="jev.availability === 'ready'">
          <button
            class="jev-toggle"
            type="button"
            :aria-pressed="jev.enabled"
            @click="emit('toggle-jev')"
          >
            Let Jev choose
          </button>
          <!--
            #523: with the toggle now a full entry path, its two-Enter confirm
            can be collapsed by request. The checkbox stands beside the toggle
            and appears exactly where the toggle is pressable — an
            auto-accept for an option that cannot be accepted is nothing's.
          -->
          <label class="jev-auto-label">
            <input
              class="jev-auto"
              type="checkbox"
              :checked="jev.autoAccept"
              @change="emit('toggle-jev-auto')"
            />
            Auto-accept Jev's choice
          </label>
        </template>
        <template v-else>
          <button class="jev-toggle" type="button" disabled aria-pressed="false">
            Let Jev choose
          </button>
          <p class="jev-unavailable-reason">{{ jevUnavailableMessage }}</p>
        </template>
      </div>

      <p v-if="jev.routing.phase === 'asking'" class="launch-note jev-status" role="status">
        Asking Jev…
      </p>

      <!--
        The decision card (#509): shown before it is acted on, and can be
        overridden — the pickers above have already been set to it (through
        the same choose/model/effort paths a click would use), so Dismiss
        puts them back rather than this card undoing anything itself.
      -->
      <div v-else-if="jevDecision !== null" class="jev-decision">
        <p class="jev-decision-summary">{{ jevDecisionSummary }}</p>
        <p class="jev-decision-parts">{{ jevPartsSummary }}</p>
        <p v-if="jevDecision.parts.trivial.value" class="jev-decision-trivial">
          Treated as a trivial prompt.
        </p>
        <p v-if="jevDecision.parts.largeContext.value" class="jev-decision-large-context">
          Large-context model preferred.
        </p>
        <p v-if="jevDecision.truncated" class="jev-decision-truncated">
          The prompt sent to Jev was trimmed to fit its request budget.
        </p>
        <p class="jev-decision-note">
          The pickers below now show this choice — change them, or press Launch again to start it.
        </p>
        <button class="jev-dismiss" type="button" @click="emit('dismiss-jev')">Dismiss</button>
      </div>
    </template>

    <!--
      One line under the composer, and it is never decoration — the discipline
      the MessagePanel's own note line holds. A refused launch carries main's
      reason in its own alert; otherwise the line says what the chosen chip can
      or cannot do, which is the thing a user is about to act on.
    -->
    <p v-if="error" class="launch-alert" role="alert">{{ error }}</p>
    <p v-else-if="spawning" class="launch-note" role="status">
      Starting the session. Its dwarf appears in the mine as soon as the panel finds it.
    </p>
    <!--
      Deliberately NOT the line above. That one says "as soon as the panel
      finds it", which is a held session's promise: its dwarf arrives carrying
      the conversation main seeded, so the panel finds it the moment it lands.
      This one arrives carrying nothing the panel can read, and is recognised
      only once main has proved it from the session's own transcript — a sweep
      or two later, and never at all where the store says nothing. So the copy
      keeps the one claim that is true either way, and adds the second as what
      the panel will do rather than as when.
    -->
    <p v-else-if="detached" class="launch-note" role="status">
      The session started. Its dwarf joins the mine on the next sweep, and this panel opens on it
      once its transcript proves which one it is.
    </p>
    <p v-else-if="refusal" class="launch-note" role="status">{{ refusal }}</p>

    <!--
      The fallback line (#509) is deliberately OUTSIDE the chain above and the
      launched/composer split: issue #509's own acceptance criterion is that
      the launch still happens and the panel SAYS that it did, so this has to
      survive past `launched` becoming true rather than vanish with the
      composer the moment the fallback's own launch starts.
    -->
    <p v-if="jev.routing.phase === 'fellBack'" class="launch-note jev-fallback" role="status">
      {{ jevFallbackMessage }}
    </p>
  </section>
</template>

<style scoped>
/*
 * The MessagePanel's own frame, deliberately to the pixel: 990px capped at what
 * the composition has, 12px radius, a 2px accent border, #2b2119 and elevation
 * 5. Submitting replaces one with the other in the same slot — one window, one
 * place in it (#162) — and a frame that changed under the swap would read as
 * two panels rather than one flow.
 *
 * The height is content-driven rather than fixed. The MessagePanel derives its
 * opening height from the latest message and can be dragged; there is no
 * message here to derive one from and nothing stated about resizing this panel,
 * so it is as tall as the chips and the composer make it — which is what the
 * source's own export shows. Since #162 that height is also the WINDOW's: the
 * panel window measures the surface it drew, so this panel growing a command
 * box grows the window with it.
 */
.add-panel {
  position: relative;
  z-index: 60;
  display: flex;
  flex-direction: column;
  gap: var(--space-nav-gap);
  width: min(var(--size-message-panel-width), 100%);
  padding-bottom: 8px;
  border: var(--border-active);
  border-radius: var(--radius-default);
  background: var(--color-panel);
  box-shadow: var(--elevation-5);
  /*
   * The MESSAGING face, not the Pixel UI one (#370). This panel is where the
   * person composes the first thing they say to a session, and the issue's
   * complaint was exactly that it did not follow the choice its own successor
   * in this slot does — submitting replaces it with the MessagePanel, and a
   * prompt that changed face on submit would read as two panels rather than
   * one flow. Declared on the root so every part of it inherits: the chips and
   * the composer are one surface, and half of it in another face is worse than
   * either whole.
   */
  font-family: var(--font-conversation);
  font-size: var(--text-meta);
  text-align: left;
}
/* The screen's name at the start, its close at the end — the export's own bar. */
.panel-bar {
  display: flex;
  flex: none;
  gap: var(--space-nav-gap);
  align-items: center;
  justify-content: space-between;
  padding: 4px 8px;
}
.panel-title {
  margin: 0;
  overflow: hidden;
  color: var(--color-cream);
  font-size: var(--text-meta);
  font-weight: normal;
  letter-spacing: 0.06em;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.launch-close {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  cursor: pointer;
  background: var(--color-cream);
}
.close-glyph {
  display: block;
  width: 70%;
  height: 70%;
  background: var(--color-panel);
  mask: var(--close-icon) center / contain no-repeat;
}
.launch-close:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}
/*
 * Chips and the command box on one line, centred, wrapping when there are more
 * providers than fit — the export centres a seven-chip row, and a machine with
 * more of them must not push the command box off the panel.
 */
.launch-choices {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  gap: var(--space-nav-gap);
  align-items: center;
  justify-content: center;
  padding: 0 8px;
}
/*
 * The design's chip: 25px tall, 12px radius, 10px type, in three states.
 *
 * One correction to `components.md`'s table, and it is a correction to the
 * TABLE rather than a decision of ours. It gives the default state a
 * `#fae2b6` background AND `#fae2b6` text — cream on cream, which is nothing at
 * all — while the verified export it links (provider-selection-panel.png) draws
 * the default chip on the panel's own dark ground with an amber border and
 * cream text. The export and the table's own text colour agree; the background
 * cell does not, so it is the cell that is wrong. Selected and unselected are
 * transcribed exactly.
 */
.provider-chip {
  flex: none;
  height: var(--size-chip-height);
  padding: 0 14px;
  border: 2px solid var(--color-accent);
  border-radius: var(--radius-default);
  color: var(--color-cream);
  cursor: pointer;
  background: var(--color-panel);
  font: inherit;
  font-size: var(--text-meta);
  white-space: nowrap;
}
.provider-chip[data-state='unselected'] {
  border-color: var(--color-nav-idle);
  color: var(--color-nav-idle);
  background: var(--color-panel);
}
.provider-chip[data-state='selected'] {
  border-color: var(--color-cream);
  color: var(--color-panel);
  background: var(--color-accent);
}
.provider-chip:hover {
  border-color: var(--color-cream);
}
.provider-chip:focus-visible {
  outline: 2px solid var(--color-cream);
  outline-offset: 2px;
}
/*
 * The command box: 25px, 12px radius, accent border, dark 10px start-aligned
 * text on the white the export draws. It takes the rest of the row so a long
 * command is readable rather than scrolling inside a chip-sized box.
 */
.launch-command {
  flex: 1;
  min-width: 160px;
  height: var(--size-chip-height);
  padding: 0 12px;
  border: var(--border-active);
  border-radius: var(--radius-default);
  color: var(--color-panel);
  background: var(--color-white);
  font: inherit;
  font-size: var(--text-meta);
  text-align: left;
}
.launch-command:focus-visible {
  outline: 2px solid var(--color-cream);
  outline-offset: 1px;
}
/*
 * The composer, on the MessagePanel's own input treatment: 865px capped, white,
 * 12px radius, accent border, start-aligned dark text.
 *
 * The disabled state is not the MessagePanel's, and that is the source's doing:
 * its export draws the closed composer as a large CREAM panel with its
 * instruction centred, which is a different thing from a greyed-out box — it
 * reads as a sign rather than as a broken control.
 */
.launch-input {
  align-self: center;
  width: min(var(--size-message-input-width), calc(100% - 16px));
  padding: 8px 10px;
  border: var(--border-active);
  border-radius: var(--radius-default);
  color: var(--color-panel);
  background: var(--color-white);
  font: inherit;
  font-size: var(--text-meta);
  resize: none;
  text-align: left;
}
.launch-input.is-instruction {
  padding: 20px 10px;
  color: var(--color-panel);
  cursor: not-allowed;
  background: var(--color-cream);
  text-align: center;
}
/* The rule the MessagePanel's input holds too: its text stays selectable. */
.launch-input.is-selectable,
.launch-command.is-selectable {
  user-select: text;
  -webkit-user-select: text;
}
.launch-input:focus-visible {
  outline: 2px solid var(--color-cream);
  outline-offset: 1px;
}
/*
 * The row under the composer (#239, launch.md's maintainer amendment):
 * "Controls use the existing chip and input surfaces of this screen; nothing
 * new is drawn." So each select borrows the provider chip's own box — 25px
 * tall, 12px radius, accent border, panel ground, cream 10px text — and the
 * row shares the chip row's own centred, wrapping layout.
 */
.launch-tuning {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  gap: var(--space-nav-gap);
  align-items: center;
  justify-content: center;
  padding: 0 8px;
}
.tuning-select {
  flex: none;
  height: var(--size-chip-height);
  padding: 0 10px;
  border: 2px solid var(--color-accent);
  border-radius: var(--radius-default);
  color: var(--color-cream);
  cursor: pointer;
  background: var(--color-panel);
  font: inherit;
  font-size: var(--text-meta);
}
.tuning-select:disabled {
  border-color: var(--color-nav-idle);
  color: var(--color-nav-idle);
  cursor: not-allowed;
}
.tuning-select:focus-visible {
  outline: 2px solid var(--color-cream);
  outline-offset: 2px;
}
/* The source note beside the model select — its own reason, or where the list came from. */
.tuning-note {
  flex: none;
  color: var(--color-tooltip-text);
  font-size: var(--text-helper);
  opacity: 0.75;
}
/* The first message, drawn exactly as the MessagePanel draws a user's. */
.launch-spawning {
  display: flex;
  flex: none;
  flex-direction: column;
  padding: 0 8px;
}
.message {
  display: flex;
  gap: var(--space-nav-gap);
  align-items: flex-start;
  justify-content: flex-end;
}
.bubble {
  margin: 0;
  overflow-wrap: anywhere;
  padding: 8px 10px;
  border: var(--border-active);
  border-radius: var(--radius-default);
  color: var(--color-panel);
  background: var(--color-cream);
  line-height: 1.35;
  white-space: pre-wrap;
  user-select: text;
  -webkit-user-select: text;
}
.portrait {
  flex: none;
  width: var(--size-portrait);
  height: var(--size-portrait);
  border: var(--border-active);
  border-radius: var(--radius-default);
  object-fit: cover;
  image-rendering: pixelated;
  user-select: none;
}
.launch-note,
.launch-alert {
  flex: none;
  margin: 0;
  padding: 0 8px;
  font-size: var(--text-helper);
  line-height: 1.3;
}
.launch-note {
  color: var(--color-tooltip-text);
  opacity: 0.75;
}
.launch-alert {
  color: var(--danger-ink);
}
/*
 * Jev (#509). No new tokens: the toggle borrows the provider chip's own box
 * (`.provider-chip`), the decision card borrows the key row's panel-deep
 * ground (`.jev-key-row`/`.jev-key-input` in JevSettings.vue), and the
 * Dismiss control borrows the same button model every settings action here
 * already uses.
 */
.jev-row {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-nav-gap);
  padding: 0 8px;
}
.jev-toggle {
  flex: none;
  height: var(--size-chip-height);
  padding: 0 14px;
  border: 2px solid var(--color-accent);
  border-radius: var(--radius-default);
  color: var(--color-cream);
  cursor: pointer;
  background: var(--color-panel);
  font: inherit;
  font-size: var(--text-meta);
  white-space: nowrap;
}
.jev-toggle[aria-pressed='true'] {
  border-color: var(--color-cream);
  color: var(--color-panel);
  background: var(--color-accent);
}
.jev-toggle:disabled {
  border-color: var(--color-nav-idle);
  color: var(--color-nav-idle);
  cursor: not-allowed;
}
.jev-toggle:focus-visible {
  outline: 2px solid var(--color-cream);
  outline-offset: 2px;
}
.jev-unavailable-reason {
  flex: none;
  margin: 0;
  color: var(--color-tooltip-text);
  font-size: var(--text-helper);
  opacity: 0.75;
}
/*
 * The #523 checkbox, drawn with what this screen already has: the toggle's
 * own cream meta type, and the browser's checkbox itself — the one control
 * whose two states need no new surface here.
 */
.jev-auto-label {
  display: flex;
  flex: none;
  gap: 6px;
  align-items: center;
  color: var(--color-cream);
  cursor: pointer;
  font-size: var(--text-meta);
  white-space: nowrap;
}
.jev-status {
  padding: 0 8px;
}
.jev-decision {
  display: flex;
  flex: none;
  flex-direction: column;
  gap: 4px;
  margin: 0 8px;
  padding: 8px 10px;
  border: var(--border-active);
  border-radius: var(--radius-default);
  background: var(--color-panel-deep);
}
.jev-decision-summary,
.jev-decision-parts {
  margin: 0;
  color: var(--color-cream);
  font-size: var(--text-meta);
}
.jev-decision-truncated,
.jev-decision-trivial,
.jev-decision-large-context,
.jev-decision-note {
  margin: 0;
  color: var(--color-tooltip-text);
  font-size: var(--text-helper);
  opacity: 0.75;
}
.jev-dismiss {
  align-self: flex-start;
  padding: 4px 10px;
  border: var(--border-active);
  border-radius: var(--radius-default);
  color: var(--color-cream);
  cursor: pointer;
  background: var(--color-control);
  font: inherit;
  font-size: var(--text-helper);
}
.jev-dismiss:focus-visible {
  outline: 2px solid var(--color-cream);
  outline-offset: 2px;
}
</style>
