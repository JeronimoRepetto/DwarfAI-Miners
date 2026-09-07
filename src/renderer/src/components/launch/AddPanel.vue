<script setup lang="ts">
import { computed } from 'vue'
import { CLOSE_ICON_SRC, USER_PORTRAIT_SRC, maskImageValue } from '../../lib/art'
import {
  COMMAND_PLACEHOLDER,
  COMPOSER_DISABLED_PLACEHOLDER,
  OTHER_CHOICE,
  type LaunchChoice,
  type LaunchPhase
} from '../../lib/launch/launchState'
import type { ProviderChip } from '../../lib/launch/providerChips'
import { MAX_DWARF_TEXT_CHARS } from '../../types'

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
}>()

const emit = defineEmits<{
  choose: [choice: LaunchChoice]
  /** The custom-command box's text, as it is typed. */
  command: [text: string]
  /** Enter in the custom-command box. */
  commit: []
  /** The composer's text, as it is typed. */
  prompt: [text: string]
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
 * browser honouring it.
 */
function onPromptKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || event.shiftKey) return
  event.preventDefault()
  if (!props.enabled) return
  emit('submit')
}

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
    <header class="panel-bar">
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

    <textarea
      v-else
      class="launch-input is-selectable"
      rows="2"
      :value="prompt"
      :maxlength="MAX_DWARF_TEXT_CHARS"
      :disabled="!enabled"
      :placeholder="placeholder"
      :class="{ 'is-instruction': !enabled }"
      :aria-label="placeholder"
      @input="emit('prompt', ($event.target as HTMLTextAreaElement).value)"
      @keydown="onPromptKeydown"
    ></textarea>

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
  </section>
</template>

<style scoped>
/*
 * The MessagePanel's own frame, deliberately to the pixel: 990px capped at what
 * the composition has, 12px radius, a 2px accent border, #2b2119 and elevation
 * 5. Submitting replaces one with the other in the same dock, and a frame that
 * changed under the swap would read as two panels rather than one flow.
 *
 * The height is content-driven rather than fixed. The MessagePanel derives its
 * opening height from the latest message and can be dragged; there is no
 * message here to derive one from and nothing stated about resizing this panel,
 * so it is as tall as the chips and the composer make it — which is what the
 * source's own export shows.
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
</style>
