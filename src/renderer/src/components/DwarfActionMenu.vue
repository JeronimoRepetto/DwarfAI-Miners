<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { MAX_DWARF_TEXT_CHARS } from '../../../shared/contracts'
import { describeEffort } from '../lib/effort'
import type { Dwarf, DwarfKickState, DwarfSendState, TextDeliveryChannel } from '../types'

/**
 * The little parchment note that opens when a dwarf is clicked: keep working
 * the way clicking always did (Open console), or hand the session a message
 * without leaving the panel — and now Kick (cancel) and Work harder (raise
 * effort), rendered from the dwarf's capability matrix (see #11).
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

const NO_CHANNEL_REASON = "This session type can't receive messages yet."

/** What each channel means, in the sender's terms. */
const CHANNEL_HINT: Record<TextDeliveryChannel, string> = {
  terminal: 'Typed straight into the session console.',
  'claude-relay': 'Relayed to the headless session by name.',
  'foreman-relay': "Delivered to this worker's foreman, tagged for them."
}

const NO_KICK_REASON = "This session type can't be canceled yet."

/**
 * What kicking that channel actually does, in honest terms: a terminal gets a
 * real interrupt keystroke, but a relay tier is a semantic ask — the session
 * decides how (or whether) to stop.
 */
const KICK_HINT: Record<TextDeliveryChannel, string> = {
  terminal: 'Sends an interrupt keystroke to the session console.',
  'claude-relay': 'Asks the agent to stop — it decides how.',
  'foreman-relay': "Asks this worker's foreman to stop it — it decides how."
}

const NO_EFFORT_REASON = "No provider supports changing a running session's effort yet."

const composing = ref(false)
const message = ref('')
const pressEnter = ref(true)
const inputRef = ref<HTMLTextAreaElement | null>(null)
const kickArmed = ref(false)

const canReceive = computed(() => props.dwarf.textDelivery !== undefined)
const channelHint = computed(() =>
  props.dwarf.textDelivery === undefined ? '' : CHANNEL_HINT[props.dwarf.textDelivery]
)
const isSending = computed(() => props.sendState?.phase === 'sending')
const canSend = computed(() => message.value.trim() !== '' && !isSending.value)
const remaining = computed(() => MAX_DWARF_TEXT_CHARS - message.value.length)

const isKicking = computed(() => props.kickState?.phase === 'kicking')
const kickChannel = computed(() => props.dwarf.capabilities?.cancel ?? null)
const canKick = computed(() => kickChannel.value !== null && !isKicking.value)
const kickHint = computed(() =>
  kickChannel.value === null ? NO_KICK_REASON : KICK_HINT[kickChannel.value]
)
const kickLabel = computed(() => {
  if (isKicking.value) return 'Kicking...'
  return kickArmed.value ? 'Confirm kick?' : 'Kick'
})

/** Normalized per provider — see lib/effort.ts — so the disabled reason still names a real value. */
const effortHint = computed(
  () =>
    `${NO_EFFORT_REASON} Currently: ${describeEffort(props.dwarf.provider, props.dwarf.effort)}.`
)

async function startComposing(): Promise<void> {
  kickArmed.value = false
  composing.value = true
  await nextTick()
  inputRef.value?.focus()
}

/** First click arms the confirmation, second click fires it — cheap insurance against a stray click. */
function onKickClick(): void {
  if (!canKick.value) return
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
  <div class="action-menu" role="menu" @keydown.escape="emit('close')" @click.stop>
    <p class="menu-title">{{ dwarf.name }}</p>

    <button class="action-open" type="button" role="menuitem" @click="emit('open-console')">
      Open console
    </button>

    <button
      class="action-send"
      type="button"
      role="menuitem"
      :disabled="!canReceive"
      :title="canReceive ? channelHint : NO_CHANNEL_REASON"
      @click="startComposing"
    >
      Send message
    </button>

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
      <p v-else-if="sendState?.phase === 'delivered'" class="send-ok" role="status">
        Delivered via {{ sendState.via }}.
      </p>
    </div>

    <button
      class="action-kick"
      type="button"
      role="menuitem"
      :disabled="!canKick"
      :class="{ 'is-armed': kickArmed }"
      :title="kickHint"
      @click="onKickClick"
    >
      {{ kickLabel }}
    </button>
    <p v-if="kickState?.phase === 'failed'" class="kick-error" role="alert">
      {{ kickState.error ?? 'The kick could not be delivered.' }}
    </p>
    <p v-else-if="kickState?.phase === 'delivered'" class="kick-ok" role="status">
      Kicked via {{ kickState.via }}.
    </p>

    <button class="action-effort" type="button" role="menuitem" disabled :title="effortHint">
      Work harder
    </button>
  </div>
</template>

<style scoped>
/* Parchment note, matching the speech bubbles the dwarfs already use. */
.action-menu {
  display: flex;
  flex-direction: column;
  gap: 5px;
  width: 214px;
  padding: 8px;
  border: 1px solid var(--parchment-line);
  border-radius: 8px;
  color: var(--parchment-ink);
  background: var(--parchment);
  box-shadow: 0 6px 18px #000a;
  font-size: 11px;
  text-align: left;
}
.menu-title {
  margin: 0 0 1px;
  overflow: hidden;
  font-weight: 700;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.action-menu button {
  padding: 5px 7px;
  border: 1px solid var(--parchment-line);
  border-radius: 6px;
  color: var(--parchment-ink);
  cursor: pointer;
  background: #fbf3e1;
  font: inherit;
  text-align: left;
}
.action-menu button:hover:not(:disabled) {
  background: #fff8e8;
}
.action-menu button:focus-visible {
  outline: 2px solid #8a5a1d;
  outline-offset: 1px;
}
.action-menu button:disabled {
  color: #8b7c66;
  cursor: not-allowed;
  background: #e4d7bd;
}
.composer {
  display: flex;
  flex-direction: column;
  gap: 4px;
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
  font-weight: 700;
}
.send-error,
.send-ok {
  margin: 0;
  font-size: 9px;
  line-height: 1.25;
}
.send-error {
  color: #8c2f14;
}
.send-ok {
  color: #3d6b2f;
}
.action-kick.is-armed {
  border-color: #8c2f14;
  color: #8c2f14;
}
.kick-error,
.kick-ok {
  margin: 0;
  font-size: 9px;
  line-height: 1.25;
}
.kick-error {
  color: #8c2f14;
}
.kick-ok {
  color: #3d6b2f;
}
</style>
