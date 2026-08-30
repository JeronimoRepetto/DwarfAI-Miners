<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { buildActionBar, type ActionBarEntry } from '../../lib/delivery/actionBar'
import { kickStatusLine, sendStatusLine } from '../../lib/delivery/deliveryVerdict'
import {
  MAX_DWARF_TEXT_CHARS,
  type Dwarf,
  type DwarfKickState,
  type DwarfSendState
} from '../../types'

/**
 * The icon action bar that opens when a dwarf is clicked (see #27): a compact
 * row of pixel-art buttons — kick (boot), boost (chili), chat (bubble),
 * console (clipboard) — replacing the old text menu. Which icons are enabled,
 * and every tooltip line, comes from lib/actionBar so this component only
 * renders and dispatches. Chat unfolds the same composer the menu carried,
 * attached below the row, so the send flow (Enter convention, char cap,
 * verdicts) is unchanged.
 */

const props = defineProps<{
  dwarf: Dwarf
  sendState?: DwarfSendState
  kickState?: DwarfKickState
}>()

const emit = defineEmits<{
  'open-console': []
  send: [payload: { text: string; pressEnter: boolean }]
  kick: []
  close: []
}>()

const composing = ref(false)
const message = ref('')
const pressEnter = ref(true)
const inputRef = ref<HTMLTextAreaElement | null>(null)
const kickArmed = ref(false)

const canReceive = computed(() => props.dwarf.textDelivery !== undefined)
const isSending = computed(() => props.sendState?.phase === 'sending')
const canSend = computed(() => message.value.trim() !== '' && !isSending.value)
const remaining = computed(() => MAX_DWARF_TEXT_CHARS - message.value.length)
const isKicking = computed(() => props.kickState?.phase === 'kicking')
/**
 * The success lines say whether the action was merely handed over or actually
 * reacted to (issue #21); failures keep their own alert rows just below, which
 * carry the reason verbatim.
 */
const sendLine = computed(() => sendStatusLine(props.sendState))
const kickLine = computed(() => kickStatusLine(props.kickState))

const actions = computed(() =>
  buildActionBar(props.dwarf, { kicking: isKicking.value, kickArmed: kickArmed.value })
)
// The chat entry's hint is the channel description whenever the composer can
// open at all, so the composer reuses it instead of re-deriving the channel.
const channelHint = computed(() => actions.value.find((action) => action.id === 'chat')?.hint ?? '')

function onAction(action: ActionBarEntry): void {
  // A disabled button never fires, but the guard keeps the dispatch honest
  // even if a test (or future markup change) clicks the handler directly.
  if (!action.enabled) return
  if (action.id === 'kick') onKickClick()
  else if (action.id === 'chat') void toggleComposer()
  else if (action.id === 'console') emit('open-console')
  // boost is unreachable while enabled is always false (v1 has no channel).
}

async function toggleComposer(): Promise<void> {
  kickArmed.value = false
  composing.value = !composing.value
  if (!composing.value) return
  await nextTick()
  inputRef.value?.focus()
}

/** First click arms the confirmation, second click fires it — cheap insurance against a stray click. */
function onKickClick(): void {
  if (!kickArmed.value) {
    kickArmed.value = true
    return
  }
  kickArmed.value = false
  emit('kick')
}

function submit(): void {
  if (!canSend.value) return
  emit('send', { text: message.value.trim(), pressEnter: pressEnter.value })
  message.value = ''
}

/**
 * Enter sends, Shift+Enter writes a newline — the convention every chat box
 * uses. A multi-line message still arrives whole: console delivery flattens it
 * so it cannot submit itself half-way (see main/textDelivery/sendKeys.ts).
 */
function onInputKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || event.shiftKey) return
  event.preventDefault()
  submit()
}
</script>

<template>
  <div class="action-bar" @keydown.escape="emit('close')" @click.stop>
    <div class="icon-row" role="toolbar" :aria-label="`Actions for ${dwarf.name}`">
      <span
        v-for="action in actions"
        :key="action.id"
        class="icon-slot"
        :class="`slot-${action.id}`"
      >
        <button
          class="icon-button"
          :class="[`icon-${action.id}`, { 'is-armed': action.id === 'kick' && kickArmed }]"
          type="button"
          :disabled="!action.enabled"
          :aria-label="action.name"
          @click="onAction(action)"
        >
          <!-- Pixel-art glyphs on a 16x16 grid, crispEdges so the blocks stay
               square like the painted sprites — no emoji, no icon font. -->
          <svg v-if="action.id === 'kick'" viewBox="0 0 16 16" aria-hidden="true">
            <rect x="7" y="1" width="5" height="2" fill="#a8703a" />
            <rect x="7" y="3" width="5" height="7" fill="#7a4a21" />
            <rect x="3" y="9" width="9" height="3" fill="#7a4a21" />
            <rect x="3" y="9" width="2" height="1" fill="#a8703a" />
            <rect x="2" y="12" width="11" height="2" fill="#3f2a14" />
          </svg>
          <svg v-else-if="action.id === 'boost'" viewBox="0 0 16 16" aria-hidden="true">
            <rect x="10" y="1" width="2" height="2" fill="#3d6b2f" />
            <rect x="9" y="3" width="4" height="2" fill="#4f8a3d" />
            <rect x="8" y="5" width="5" height="3" fill="#c23a20" />
            <rect x="6" y="8" width="6" height="3" fill="#c23a20" />
            <rect x="3" y="11" width="6" height="2" fill="#c23a20" />
            <rect x="4" y="11" width="1" height="1" fill="#e87a5a" />
            <rect x="8" y="6" width="1" height="1" fill="#e87a5a" />
          </svg>
          <svg v-else-if="action.id === 'chat'" viewBox="0 0 16 16" aria-hidden="true">
            <rect x="1" y="2" width="14" height="9" fill="#4b3c28" />
            <rect x="2" y="3" width="12" height="7" fill="#fbf3e1" />
            <rect x="4" y="11" width="4" height="2" fill="#4b3c28" />
            <rect x="5" y="11" width="2" height="1" fill="#fbf3e1" />
            <rect x="4" y="6" width="2" height="1" fill="#4b3c28" />
            <rect x="7" y="6" width="2" height="1" fill="#4b3c28" />
            <rect x="10" y="6" width="2" height="1" fill="#4b3c28" />
          </svg>
          <svg v-else viewBox="0 0 16 16" aria-hidden="true">
            <rect x="2" y="2" width="12" height="13" fill="#8a5a1d" />
            <rect x="3" y="4" width="10" height="10" fill="#fbf3e1" />
            <rect x="5" y="1" width="6" height="3" fill="#4b3c28" />
            <rect x="4" y="6" width="8" height="1" fill="#6b5a44" />
            <rect x="4" y="8" width="8" height="1" fill="#6b5a44" />
            <rect x="4" y="10" width="5" height="1" fill="#6b5a44" />
          </svg>
        </button>
        <!-- The classic small tooltip (same dark look as DwarfTooltip), shown
             by CSS on hover/focus-within — no placement math needed because it
             anchors to its own slot inside the already-clamped bar. -->
        <span class="icon-tip" role="tooltip">
          <strong>{{ action.name }}</strong>
          <span>{{ action.hint }}</span>
        </span>
      </span>
    </div>

    <div v-if="composing && canReceive" class="composer">
      <textarea
        ref="inputRef"
        v-model="message"
        class="message-input"
        rows="3"
        :maxlength="MAX_DWARF_TEXT_CHARS"
        placeholder="Type a message for this session..."
        aria-label="Message to send to this session"
        @keydown="onInputKeydown"
      ></textarea>
      <p class="channel-hint">{{ channelHint }}</p>
      <label class="enter-toggle">
        <input v-model="pressEnter" class="press-enter" type="checkbox" />
        Press Enter in the session
      </label>
      <div class="composer-actions">
        <span class="char-count" :class="{ 'is-low': remaining < 200 }">{{ remaining }}</span>
        <button class="send-button" type="button" :disabled="!canSend" @click="submit">
          {{ isSending ? 'Sending...' : 'Send' }}
        </button>
      </div>
      <p v-if="sendState?.phase === 'failed'" class="send-error" role="alert">
        {{ sendState.error ?? 'The message could not be delivered.' }}
      </p>
      <p v-else-if="sendLine" class="send-ok" role="status">{{ sendLine }}</p>
    </div>

    <p v-if="kickState?.phase === 'failed'" class="kick-error" role="alert">
      {{ kickState.error ?? 'The kick could not be delivered.' }}
    </p>
    <p v-else-if="kickLine" class="kick-ok" role="status">{{ kickLine }}</p>
  </div>
</template>

<style scoped>
/* Parchment strip, matching the speech bubbles the dwarfs already use. */
.action-bar {
  display: flex;
  flex-direction: column;
  gap: 5px;
  width: max-content;
  padding: 6px;
  border: 1px solid var(--parchment-line);
  border-radius: 8px;
  color: var(--parchment-ink);
  background: var(--parchment);
  box-shadow: 0 6px 18px #000a;
  font-size: 11px;
  text-align: left;
}
.icon-row {
  display: flex;
  gap: 4px;
}
.icon-slot {
  position: relative;
  display: inline-flex;
}
.icon-button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 4px;
  border: 1px solid var(--parchment-line);
  border-radius: 6px;
  cursor: pointer;
  background: #fbf3e1;
  line-height: 0;
}
.icon-button svg {
  width: 100%;
  height: 100%;
  /* Blocky pixel look: no anti-aliasing between the rect "pixels". */
  shape-rendering: crispEdges;
}
.icon-button:hover:not(:disabled) {
  background: #fff8e8;
}
.icon-button:focus-visible {
  outline: 2px solid #8a5a1d;
  outline-offset: 1px;
}
.icon-button:disabled {
  cursor: not-allowed;
  background: #e4d7bd;
}
.icon-button:disabled svg {
  filter: grayscale(0.8);
  opacity: 0.55;
}
/* An armed kick turns hostile-red until confirmed or disarmed. */
.icon-kick.is-armed {
  border-color: #8c2f14;
  outline: 1px solid #8c2f14;
}
/*
 * The classic small tooltip look (see DwarfTooltip.vue), anchored above its
 * icon. Kept in the DOM at all times and revealed by CSS so hover and
 * keyboard focus behave identically without any show/hide script.
 */
.icon-tip {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 50%;
  z-index: 10;
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: max-content;
  max-width: 170px;
  padding: 6px 8px;
  border: 1px solid var(--line-strong);
  border-radius: 7px;
  color: var(--ink);
  background: #15100bf2;
  box-shadow: 0 4px 14px #000a;
  font-size: 10px;
  line-height: 1.3;
  text-align: left;
  opacity: 0;
  translate: -50% 0;
  pointer-events: none;
  transition: opacity 0.15s;
}
.icon-tip strong {
  font-size: 11px;
}
.icon-tip span {
  color: var(--ink-dim);
}
.icon-slot:hover .icon-tip,
.icon-slot:focus-within .icon-tip {
  opacity: 1;
}
.composer {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 200px;
  margin-top: 2px;
  padding-top: 6px;
  border-top: 1px dashed var(--parchment-line);
}
.message-input {
  padding: 5px 6px;
  border: 1px solid var(--parchment-line);
  border-radius: 6px;
  color: var(--parchment-ink);
  background: #fffaf0;
  font: inherit;
  resize: none;
  user-select: text;
  -webkit-user-select: text;
}
.message-input:focus-visible {
  outline: 2px solid #8a5a1d;
  outline-offset: 1px;
}
.channel-hint {
  margin: 0;
  color: #6b5a44;
  font-size: 9px;
  line-height: 1.25;
}
.enter-toggle {
  display: flex;
  gap: 5px;
  align-items: center;
  cursor: pointer;
  font-size: 10px;
}
.press-enter {
  margin: 0;
  accent-color: #8a5a1d;
}
.composer-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
.char-count {
  color: #8b7c66;
  font-size: 9px;
  font-variant-numeric: tabular-nums;
}
.char-count.is-low {
  color: #a33f1f;
}
.send-button {
  flex: none;
  padding: 5px 7px;
  border: 1px solid var(--parchment-line);
  border-radius: 6px;
  color: var(--parchment-ink);
  cursor: pointer;
  background: #fbf3e1;
  font: inherit;
  font-weight: 700;
}
.send-button:hover:not(:disabled) {
  background: #fff8e8;
}
.send-button:focus-visible {
  outline: 2px solid #8a5a1d;
  outline-offset: 1px;
}
.send-button:disabled {
  color: #8b7c66;
  cursor: not-allowed;
  background: #e4d7bd;
}
.send-error,
.send-ok,
.kick-error,
.kick-ok {
  margin: 0;
  max-width: 200px;
  font-size: 9px;
  line-height: 1.25;
}
.send-error,
.kick-error {
  color: #8c2f14;
}
.send-ok,
.kick-ok {
  color: #3d6b2f;
}
</style>
