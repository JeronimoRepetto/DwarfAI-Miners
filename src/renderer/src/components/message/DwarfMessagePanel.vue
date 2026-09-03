<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import {
  BOOST_ICON_SRC,
  CLOSE_ICON_SRC,
  KICK_ICON_SRC,
  PORTRAIT_SRC,
  USER_PORTRAIT_SRC,
  maskImageValue
} from '../../lib/art'
import { CONSOLE_HINT, buildActionBar } from '../../lib/delivery/actionBar'
import { kickStatusLine, sendStatusLine } from '../../lib/delivery/deliveryVerdict'
import { conversationOf, latestText } from '../../lib/message/conversation'
import {
  MESSAGE_PANEL_MAX_HEIGHT,
  clampPanelHeight,
  initialPanelHeight
} from '../../lib/message/panelHeight'
import {
  MAX_DWARF_TEXT_CHARS,
  type Dwarf,
  type DwarfAnswerState,
  type DwarfFeedResult,
  type DwarfKickState,
  type DwarfSendState
} from '../../types'
import DwarfQuestionCard from '../dwarf/DwarfQuestionCard.vue'

/**
 * The design's MessagePanel (#159): the surface a selected dwarf opens at the
 * bottom of the screen, carrying its portrait, the conversation, the input,
 * the history tab and the kick/boost/close controls. It replaces the interim
 * icon action bar entirely, and the question cards (#128) move into the place
 * the design drew for them, directly above the input.
 *
 * Thin, like every component here. Which words may be shown and what the panel
 * claims they are is lib/message/conversation's; the four sizing rules are
 * lib/message/panelHeight's; which controls are live and what a disabled one
 * says is lib/delivery/actionBar's — the capability model the old bar was only
 * ever a rendering of, which is why that module outlived the component.
 *
 * ## Two things it deliberately does not do
 *
 * It does not resize itself when a message arrives. `screens/mine.md` is
 * explicit: the height derives from the latest message when the panel OPENS,
 * and once open new messages leave it alone — a panel that grew under a reader
 * mid-sentence would be worse than one that scrolls, which is exactly why the
 * messages scroll independently.
 *
 * And it never clears the question card on its own, for the reason
 * DwarfQuestionCard states at length: only main's next snapshot may drop a
 * `pendingQuestion`.
 */

const props = defineProps<{
  dwarf: Dwarf
  /**
   * The transcript read for this dwarf, for a session this panel only
   * OBSERVES. Undefined while the read is in flight, which is its own answer
   * rather than an empty one (see conversationOf).
   */
  feed?: DwarfFeedResult
  sendState?: DwarfSendState
  kickState?: DwarfKickState
  /** The verdict of the last answer given for this dwarf (see DwarfQuestionCard). */
  answerState?: DwarfAnswerState
}>()

const emit = defineEmits<{
  send: [payload: { text: string; pressEnter: boolean }]
  kick: []
  close: []
  /** One of the agent's own option labels, once Enter confirmed it. */
  answer: [label: string]
  /** Focus this session's console — where the old bar's fourth icon went. */
  'open-console': []
}>()

const message = ref('')
const kickArmed = ref(false)
const historyOpen = ref(false)

const conversation = computed(() => conversationOf(props.dwarf, props.feed))

/*
 * The opening height, taken ONCE. Read during setup and never recomputed: the
 * panel is mounted per selection, so closing and reopening is a fresh mount
 * and therefore a fresh calculation — which is the design's third rule getting
 * itself for free, and its second rule (new messages do not resize) holding
 * because nothing here watches the conversation.
 */
const height = ref(
  initialPanelHeight(latestText(conversation.value), props.dwarf.pendingQuestion !== undefined)
)
/** The height to give back when the history tab closes again. */
const collapsedHeight = ref(height.value)

const actions = computed(() =>
  buildActionBar(props.dwarf, { kicking: isKicking.value, kickArmed: kickArmed.value })
)
function action(id: 'kick' | 'boost' | 'chat') {
  return actions.value.find((entry) => entry.id === id)
}

const canReceive = computed(() => props.dwarf.textDelivery !== undefined)
const isSending = computed(() => props.sendState?.phase === 'sending')
const isKicking = computed(() => props.kickState?.phase === 'kicking')

const agentPortrait = computed(() => PORTRAIT_SRC[props.dwarf.role])

/**
 * The success lines say whether the action was merely handed over or actually
 * reacted to (issue #21); a failure carries its own reason verbatim, in its
 * own alert row.
 */
const sendLine = computed(() => sendStatusLine(props.sendState))
const kickLine = computed(() => kickStatusLine(props.kickState))
const statusLine = computed(() => sendLine.value ?? kickLine.value)
const alertLine = computed(() => {
  if (props.sendState?.phase === 'failed') {
    return props.sendState.error ?? 'The message could not be delivered.'
  }
  if (props.kickState?.phase === 'failed') {
    return props.kickState.error ?? 'The kick could not be delivered.'
  }
  return null
})

/*
 * Open on the LATEST message. The design orders a transcript oldest first, so
 * an unscrolled panel would open on the message furthest from whatever just
 * happened — and the height it opened at was derived from the newest one.
 *
 * Only on mount and when the history expands, never on a new message: the
 * panel must not yank a reader to the bottom mid-sentence, which is the same
 * reason a new message does not resize it.
 */
const conversationRef = ref<HTMLElement | null>(null)

async function showLatest(): Promise<void> {
  await nextTick()
  const list = conversationRef.value
  if (list === null) return
  list.scrollTop = list.scrollHeight
}

onMounted(showLatest)

function toggleHistory(): void {
  historyOpen.value = !historyOpen.value
  void showLatest()
  if (historyOpen.value) {
    collapsedHeight.value = height.value
    height.value = MESSAGE_PANEL_MAX_HEIGHT
    return
  }
  height.value = collapsedHeight.value
}

/*
 * Vertical only, from the panel's own top edge — the one direction the source
 * allows, and the one gesture a bottom-docked panel has: dragging the edge UP
 * makes it taller, so the delta is subtracted rather than added.
 *
 * Pointer events rather than mouse, so a trackpad, a pen and a touchscreen all
 * work from one handler; the capture keeps the drag alive when the pointer
 * outruns a 6px strip. Nothing here reads clientX, because there is no width
 * for it to change.
 */
const dragFrom = ref<{ y: number; height: number } | null>(null)

function startResize(event: PointerEvent): void {
  dragFrom.value = { y: event.clientY, height: height.value }
  ;(event.target as HTMLElement | null)?.setPointerCapture?.(event.pointerId)
}

function resize(event: PointerEvent): void {
  const from = dragFrom.value
  if (from === null) return
  height.value = clampPanelHeight(from.height + (from.y - event.clientY))
  if (historyOpen.value) collapsedHeight.value = height.value
}

function endResize(): void {
  dragFrom.value = null
}

/** The same resize for a keyboard, which cannot grab a handle at all. */
const KEYBOARD_RESIZE_STEP = 20
function resizeByKey(event: KeyboardEvent): void {
  const step =
    event.key === 'ArrowUp'
      ? KEYBOARD_RESIZE_STEP
      : event.key === 'ArrowDown'
        ? -KEYBOARD_RESIZE_STEP
        : 0
  if (step === 0) return
  event.preventDefault()
  height.value = clampPanelHeight(height.value + step)
  if (historyOpen.value) collapsedHeight.value = height.value
}

function submit(): void {
  const text = message.value.trim()
  if (text === '' || isSending.value || !canReceive.value) return
  // Always with the session's own Enter: `screens/mine.md` says Enter sends,
  // and the panel it draws has no second control to say otherwise.
  emit('send', { text, pressEnter: true })
  message.value = ''
}

/** Enter sends, Shift+Enter writes a newline — the convention every composer here uses. */
function onInputKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || event.shiftKey) return
  event.preventDefault()
  submit()
}

/** First click arms the confirmation, second click fires it. */
function onKick(): void {
  if (action('kick')?.enabled !== true) return
  if (!kickArmed.value) {
    kickArmed.value = true
    return
  }
  kickArmed.value = false
  emit('kick')
}

// A half-confirmed kick must not survive the panel moving to another dwarf.
watch(
  () => props.dwarf.id,
  () => {
    kickArmed.value = false
  }
)
</script>

<template>
  <section
    class="message-panel"
    :class="{ 'is-history': historyOpen }"
    :style="{ height: `${height}px` }"
    :aria-label="`Messages with ${dwarf.name}`"
    @keydown.escape="emit('close')"
    @click.stop
  >
    <!-- Vertical-only resize, on the panel's own top edge. -->
    <div
      class="panel-resize"
      role="separator"
      aria-orientation="horizontal"
      :aria-label="`Resize the message panel for ${dwarf.name}`"
      tabindex="0"
      @pointerdown="startResize"
      @pointermove="resize"
      @pointerup="endResize"
      @pointercancel="endResize"
      @keydown="resizeByKey"
    ></div>

    <header class="panel-bar">
      <!--
        The design draws the dwarf's name here and no fourth icon, so the name
        IS the control that focuses this session's console — which is where
        the old action bar's console icon went.
      -->
      <button class="panel-agent" type="button" :title="CONSOLE_HINT" @click="emit('open-console')">
        {{ dwarf.name }}
      </button>
      <button
        class="panel-history"
        type="button"
        :aria-expanded="historyOpen"
        :aria-label="historyOpen ? 'Collapse message history' : 'Expand message history'"
        @click="toggleHistory"
      >
        <span class="history-arrow" aria-hidden="true"></span>
      </button>
      <button class="panel-close" type="button" aria-label="Close messages" @click="emit('close')">
        <span
          class="close-glyph"
          :style="{ '--close-icon': maskImageValue(CLOSE_ICON_SRC) }"
          aria-hidden="true"
        ></span>
      </button>
    </header>

    <!--
      Independently scrollable, which is a rule and not a convenience: the
      source says history can be inspected here without expanding the tab.
    -->
    <div
      ref="conversationRef"
      class="panel-conversation"
      tabindex="0"
      :aria-label="conversation.note"
    >
      <p v-if="conversation.messages.length === 0" class="panel-empty">{{ conversation.note }}</p>
      <article
        v-for="entry in conversation.messages"
        :key="entry.key"
        class="message"
        :class="entry.from === 'agent' ? 'is-agent' : 'is-user'"
      >
        <img
          v-if="entry.from === 'agent'"
          class="portrait"
          :src="agentPortrait"
          :alt="`${dwarf.name}, ${dwarf.role}`"
          draggable="false"
        />
        <p class="bubble">{{ entry.text }}</p>
        <img
          v-if="entry.from === 'user'"
          class="portrait"
          :src="USER_PORTRAIT_SRC"
          alt="You"
          draggable="false"
        />
      </article>
    </div>

    <div class="panel-composer">
      <!--
        The ask REPLACES the composer while one is open, which is what the
        design's two question exports draw: the option cards, then `Other
        Thing` and the card's own box where the panel's input would be. It is
        never behind a toggle, because it is the reason the dwarf was clicked.

        A free-form reply leaves on the ordinary message channel, because the
        answer channel takes back only the agent's own words.
      -->
      <DwarfQuestionCard
        v-if="dwarf.pendingQuestion"
        class="panel-ask"
        :question="dwarf.pendingQuestion"
        :answer-state="answerState"
        @answer="emit('answer', $event)"
        @send-text="emit('send', $event)"
      />
      <textarea
        v-else
        v-model="message"
        class="panel-input is-selectable"
        rows="2"
        :maxlength="MAX_DWARF_TEXT_CHARS"
        :disabled="!canReceive"
        :title="action('chat')?.hint"
        placeholder="Write here..."
        :aria-label="`Message ${dwarf.name}`"
        @keydown="onInputKeydown"
      ></textarea>
      <div class="panel-controls">
        <button
          class="control-kick"
          :class="{ 'is-armed': kickArmed }"
          type="button"
          :disabled="action('kick')?.enabled !== true"
          :aria-label="action('kick')?.name"
          :title="action('kick')?.hint"
          @click="onKick"
        >
          <span
            class="control-glyph"
            :style="{ '--control-icon': maskImageValue(KICK_ICON_SRC) }"
            aria-hidden="true"
          ></span>
        </button>
        <!--
          Boost is drawn where the design puts it and does nothing, on purpose.
          No provider exposes a channel to change a running session's effort
          (DwarfCapabilities.adjustEffort is the literal null), and the SDK's
          own `applyFlagSettings` resolves as a silent no-op without a
          supportsEffort guard — so a live button here would answer a click
          with silence, which is a worse lie than a disabled one that says why.
        -->
        <button
          class="control-boost"
          type="button"
          disabled
          :aria-label="action('boost')?.name"
          :title="action('boost')?.hint"
        >
          <span
            class="control-glyph"
            :style="{ '--control-icon': maskImageValue(BOOST_ICON_SRC) }"
            aria-hidden="true"
          ></span>
        </button>
      </div>
    </div>

    <p v-if="alertLine" class="panel-alert" role="alert">{{ alertLine }}</p>
    <p v-else-if="statusLine" class="panel-status" role="status">{{ statusLine }}</p>
    <p v-else class="panel-note">{{ conversation.note }}</p>
  </section>
</template>

<style scoped>
/*
 * The design's panel: 990px, 12px radius, a 2px accent border, #2b2119 and
 * elevation 5 — every one of them a token rather than a literal.
 *
 * `min()` against the width available is the reconciliation (#159). The
 * design's own mine-and-message mock draws this panel 1026px wide BESIDE the
 * shell on a 1350px screen, i.e. as a second surface on the desktop; this app
 * is one docked window, and only its widest composition has 990 design pixels
 * to give. So the panel takes the design's width where the composition has it
 * and the composition's where it does not, rather than hanging off the side.
 */
.message-panel {
  position: relative;
  z-index: 60;
  display: flex;
  flex-direction: column;
  /* The height is fixed, so nothing inside it may spill past the border. */
  overflow: hidden;
  width: min(var(--size-message-panel-width), 100%);
  border: var(--border-active);
  border-radius: var(--radius-default);
  background: var(--color-panel);
  box-shadow: var(--elevation-5);
  font-size: var(--text-meta);
  text-align: left;
}
/*
 * The grab strip, on the top edge. Sized in the border radius so it cannot
 * cover a corner, and drawn only on hover/focus: the design shows no handle,
 * so the affordance appears when it is being reached for.
 */
.panel-resize {
  position: absolute;
  top: -3px;
  right: var(--radius-default);
  left: var(--radius-default);
  height: 7px;
  border-radius: 4px;
  cursor: ns-resize;
  touch-action: none;
}
.panel-resize:hover,
.panel-resize:focus-visible {
  outline: none;
  background: var(--color-accent);
}
/*
 * The design's own title row: the agent's name at the start, the history tab
 * CENTRED, the close at the end. A grid rather than a flex row, because
 * centring the middle child of three unequal ones is what a grid does without
 * a spacer element on each side.
 */
.panel-bar {
  display: grid;
  flex: none;
  grid-template-columns: 1fr auto 1fr;
  gap: var(--space-nav-gap);
  align-items: center;
  padding: 4px 8px;
}
.panel-agent {
  justify-self: start;
  max-width: 100%;
  overflow: hidden;
  padding: 0;
  border: 0;
  color: var(--color-cream);
  cursor: pointer;
  background: transparent;
  font: inherit;
  letter-spacing: 0.06em;
  text-align: left;
  text-overflow: ellipsis;
  text-transform: uppercase;
  white-space: nowrap;
}
.panel-agent:hover {
  color: var(--color-accent);
}
.panel-history {
  justify-self: center;
}
.panel-close {
  justify-self: end;
}
.panel-history,
.panel-close {
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
  background: transparent;
}
/* The design's own small triangle, pointing at the history it opens. */
.history-arrow {
  width: 0;
  height: 0;
  border-right: 6px solid transparent;
  border-bottom: 7px solid var(--color-cream);
  border-left: 6px solid transparent;
}
.is-history .history-arrow {
  rotate: 180deg;
}
.panel-close {
  background: var(--color-cream);
}
.close-glyph {
  display: block;
  width: 70%;
  height: 70%;
  background: var(--color-panel);
  mask: var(--close-icon) center / contain no-repeat;
}
.panel-history:focus-visible,
.panel-close:focus-visible,
.panel-agent:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}
/*
 * The messages, with their own scroll — a stated rule, so that history can be
 * read here without expanding the tab.
 */
.panel-conversation {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: var(--space-nav-gap);
  overflow-y: auto;
  min-height: 0;
  padding: 0 8px 8px;
}
.panel-empty {
  margin: auto;
  color: var(--color-tooltip-text);
  text-align: center;
}
.message {
  display: flex;
  flex: none;
  gap: var(--space-nav-gap);
  align-items: flex-start;
}
.message.is-user {
  justify-content: flex-end;
}
/* 100px, 12px radius, 2px accent border — the source's own portrait treatment. */
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
/*
 * Both bubbles use the same surface and the same ink; only the alignment
 * differs, exactly as the design has it.
 */
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
/*
 * The composer row: whichever input is current — the ordinary box, or the ask
 * that replaces it — with the two controls stacked at its right edge, which is
 * where every one of the design's exports puts them.
 */
.panel-composer {
  display: flex;
  flex: none;
  gap: var(--space-nav-gap);
  align-items: flex-end;
  min-height: 0;
  padding: 0 8px 4px;
}
/* The re-homed question card takes the composer's whole width. */
.panel-ask {
  flex: 1;
  min-width: 0;
  max-width: var(--size-message-input-width);
}
/*
 * The design's input: 865px, white, 12px radius, accent border, start-aligned
 * dark text. It is capped rather than fixed for the same reason the panel is.
 */
.panel-input {
  flex: 1;
  max-width: var(--size-message-input-width);
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
/* A stated rule of its own: the input's text must stay selectable. */
.panel-input.is-selectable {
  user-select: text;
  -webkit-user-select: text;
}
.panel-input:disabled {
  color: #6b5a44;
  cursor: not-allowed;
  background: #e4d7bd;
}
.panel-input:focus-visible {
  outline: 2px solid var(--color-cream);
  outline-offset: 1px;
}
/* Kick above, boost below, at the input's right edge — the design's own stack. */
.panel-controls {
  display: flex;
  flex: none;
  flex-direction: column;
  gap: 4px;
}
.control-kick,
.control-boost {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  cursor: pointer;
  background: transparent;
}
.control-glyph {
  display: block;
  width: 100%;
  height: 100%;
  background: var(--color-cream);
  mask: var(--control-icon) center / contain no-repeat;
}
.control-kick:hover:not(:disabled) .control-glyph,
.control-boost:hover:not(:disabled) .control-glyph {
  background: var(--color-accent);
}
/* An armed kick turns hostile-red until it is confirmed. */
.control-kick.is-armed .control-glyph {
  background: var(--danger-line);
}
.control-kick:disabled,
.control-boost:disabled {
  cursor: not-allowed;
}
.control-kick:disabled .control-glyph,
.control-boost:disabled .control-glyph {
  opacity: 0.4;
}
.control-kick:focus-visible,
.control-boost:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}
/*
 * One line under the input, and it is never decoration: it says what the
 * messages above ARE when nothing is in flight, and the delivery verdict when
 * something is — a ✓ and a ✓✓ are different facts and the copy keeps them
 * apart (see lib/delivery/deliveryVerdict).
 */
.panel-note,
.panel-status,
.panel-alert {
  flex: none;
  margin: 0;
  padding: 0 8px 8px;
  font-size: 9px;
  line-height: 1.3;
}
.panel-note {
  color: var(--color-tooltip-text);
  opacity: 0.75;
}
.panel-status {
  color: #8fd07a;
}
.panel-alert {
  color: var(--danger-ink);
}
</style>
