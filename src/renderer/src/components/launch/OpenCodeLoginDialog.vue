<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, onUnmounted, ref, useId, watch } from 'vue'
import type { OpenCodeLoginView } from '../../lib/launch/openCodeLogin'
import type { OpenCodeAuthPrompt } from '../../types'

/**
 * The OpenCode login dialog (#597 T5): opened when a launch was held back
 * because the chosen model's provider has no credential, so the person can
 * sign in without a terminal and the session then starts by itself.
 *
 * ## The design source it borrows from
 *
 * No login dialog exists in the source. The frame is `components.md`'s shared
 * Confirmation modal — the one other dialog the source draws — at its 326px
 * width: `#14100b` on a `4px #fae2b6` border, 12px radius and margin, the
 * headline in `#d19831`, helper copy in `#fae2b6`, fields on `#272015` with an
 * accent border, buttons on the shared enabled/disabled model. Its fixed 265px
 * height is not kept: an OAuth step carries instructions and a link the
 * Confirmation modal never had to hold. The dim behind it is foundations'
 * `color-black` at 50%, the overlay filter the Lab/Market panels already use.
 *
 * ## Presentational
 *
 * Everything it draws is `view`, read off `lib/launch/openCodeLogin` by
 * `useOpenCodeLogin`. The only state of its own is the text of the two secret
 * fields, held exactly as ResetMetricsModal holds its typed word — and unlike
 * that word, emptied the moment it is reported and again on unmount, so a
 * secret lives in this component no longer than the press that sends it.
 */
const props = defineProps<{
  view: OpenCodeLoginView
}>()

const emit = defineEmits<{
  close: []
  retry: []
  'submit-key': [key: string]
  'choose-oauth': [index: number]
  answer: [key: string, value: string]
  continue: []
  back: []
  'submit-code': [code: string]
  'cancel-wait': []
  'open-link': []
}>()

const id = useId()
const titleId = `${id}-title`
const explanationId = `${id}-explanation`
const keyId = `${id}-key`
const codeId = `${id}-code`

function promptId(prompt: OpenCodeAuthPrompt): string {
  return `${id}-prompt-${prompt.key}`
}

function optionLabel(option: { label: string; hint?: string }): string {
  return option.hint === undefined ? option.label : `${option.label} — ${option.hint}`
}

const dialogRef = ref<HTMLElement | null>(null)
const key = ref('')
const code = ref('')

function sendKey(): void {
  const value = key.value
  key.value = ''
  if (value.trim() === '') return
  emit('submit-key', value)
}

function sendCode(): void {
  const value = code.value
  code.value = ''
  if (value.trim() === '') return
  emit('submit-code', value)
}

function answerFrom(prompt: OpenCodeAuthPrompt, event: Event): void {
  emit('answer', prompt.key, (event.target as HTMLInputElement | HTMLSelectElement).value)
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href]'

function focusables(): HTMLElement[] {
  return Array.from(dialogRef.value?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
}

/**
 * Where focus lands: the first field when there is one, since that is the
 * thing to do; otherwise the first action that is not the close glyph;
 * otherwise the dialog itself, so a keyboard user is never left outside it.
 */
function focusInto(): void {
  const root = dialogRef.value
  if (root === null) return
  const field = root.querySelector<HTMLElement>('input:not([disabled]), select:not([disabled])')
  const action = focusables().find((element) => !element.classList.contains('login-close'))
  ;(field ?? action ?? root).focus()
}

/**
 * Escape closes (which cancels any wait, in the composable) and Tab stays
 * inside: the Add Panel behind is inert while this is open, and a Tab that
 * walked out would land on nothing that can be used.
 */
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.stopPropagation()
    emit('close')
    return
  }
  if (event.key !== 'Tab') return
  const items = focusables()
  const first = items[0]
  const last = items[items.length - 1]
  if (first === undefined || last === undefined) {
    event.preventDefault()
    return
  }
  const active = document.activeElement
  const inside = active instanceof Node && dialogRef.value?.contains(active) === true
  if (event.shiftKey && (active === first || !inside)) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && (active === last || !inside)) {
    event.preventDefault()
    first.focus()
  }
}

// Whatever held focus before the dialog opened gets it back when it closes.
const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null

onMounted(focusInto)

// A step change removes the control that had focus; put it back inside.
watch(
  () => props.view.step,
  async () => {
    await nextTick()
    const active = document.activeElement
    if (!(active instanceof Node) || dialogRef.value?.contains(active) !== true) focusInto()
  }
)

onBeforeUnmount(() => {
  key.value = ''
  code.value = ''
})

onUnmounted(() => {
  if (previous?.isConnected === true) previous.focus()
})
</script>

<template>
  <div class="login-backdrop">
    <div
      ref="dialogRef"
      class="login-dialog"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="titleId"
      :aria-describedby="explanationId"
      :aria-busy="view.busy ? 'true' : 'false'"
      tabindex="-1"
      @keydown="onKeydown"
    >
      <header class="login-head">
        <h2 :id="titleId" class="login-title">{{ view.title }}</h2>
        <button class="login-close" type="button" aria-label="Close" @click="emit('close')">
          &times;
        </button>
      </header>
      <p :id="explanationId" class="login-message">{{ view.explanation }}</p>

      <p class="login-status" role="status" aria-live="polite">{{ view.busyLabel ?? '' }}</p>
      <p v-if="view.notice" class="login-error" role="alert">{{ view.notice }}</p>

      <div v-if="view.step === 'methods-failed'" class="login-actions">
        <button class="login-button login-retry" type="button" @click="emit('retry')">
          Try again
        </button>
      </div>

      <template v-if="view.step === 'choose'">
        <form v-if="view.offersApiKey" class="login-key-form" @submit.prevent="sendKey">
          <label class="login-label" :for="keyId">API key for {{ view.provider }}</label>
          <input
            :id="keyId"
            v-model="key"
            class="login-input login-key"
            type="password"
            autocomplete="off"
            spellcheck="false"
          />
          <button class="login-button login-save" type="submit">Save key</button>
        </form>
        <div v-if="view.oauthChoices.length > 0" class="login-methods">
          <p class="login-label">{{ view.offersApiKey ? 'Or sign in with' : 'Sign in with' }}</p>
          <button
            v-for="choice in view.oauthChoices"
            :key="choice.index"
            class="login-button login-method"
            type="button"
            @click="emit('choose-oauth', choice.index)"
          >
            {{ choice.label }}
          </button>
        </div>
      </template>

      <template v-if="view.step === 'prompts'">
        <div v-for="entry in view.prompts" :key="entry.prompt.key" class="login-field">
          <label class="login-label" :for="promptId(entry.prompt)">{{
            entry.prompt.message
          }}</label>
          <select
            v-if="entry.prompt.type === 'select'"
            :id="promptId(entry.prompt)"
            class="login-input login-prompt"
            :value="entry.value"
            @change="answerFrom(entry.prompt, $event)"
          >
            <option
              v-for="option in entry.prompt.options"
              :key="option.value"
              :value="option.value"
            >
              {{ optionLabel(option) }}
            </option>
          </select>
          <input
            v-else
            :id="promptId(entry.prompt)"
            class="login-input login-prompt"
            type="text"
            autocomplete="off"
            :placeholder="entry.prompt.placeholder"
            :value="entry.value"
            @input="answerFrom(entry.prompt, $event)"
          />
        </div>
        <div class="login-actions">
          <button class="login-button login-back" type="button" @click="emit('back')">Back</button>
          <button
            class="login-button login-continue"
            type="button"
            :disabled="!view.promptsComplete"
            @click="emit('continue')"
          >
            Continue
          </button>
        </div>
      </template>

      <template
        v-if="view.step === 'code' || view.step === 'completing' || view.step === 'waiting'"
      >
        <p v-if="view.instructions" class="login-instructions">{{ view.instructions }}</p>
        <a
          v-if="view.link"
          class="login-link"
          :href="view.link"
          :title="view.link"
          @click.prevent="emit('open-link')"
        >
          Open the sign-in page in your browser
        </a>
        <p v-else-if="view.url" class="login-url">{{ view.url }}</p>

        <form v-if="view.step === 'code'" class="login-code-form" @submit.prevent="sendCode">
          <label class="login-label" :for="codeId">Paste the code you were given</label>
          <input
            :id="codeId"
            v-model="code"
            class="login-input login-code"
            type="password"
            autocomplete="off"
            spellcheck="false"
          />
          <div class="login-actions">
            <button class="login-button login-back" type="button" @click="emit('back')">
              Back
            </button>
            <button class="login-button login-save" type="submit">Sign in</button>
          </div>
        </form>

        <div v-if="view.step === 'waiting'" class="login-actions">
          <button class="login-button login-cancel" type="button" @click="emit('cancel-wait')">
            Cancel
          </button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
/*
 * Spans the launch slot it is stacked into (MessagePanelWindow's
 * `.launch-slot`) and dims the Add Panel under it — foundations' overlay
 * filter, `color-black` at 50%. In the flow rather than absolute, because this
 * window is sized from what it measures: a dialog taller than the Add Panel
 * has to grow the window, not be cut off by it.
 */
.login-backdrop {
  z-index: 96;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-modal-margin);
  border-radius: var(--radius-default);
  background: color-mix(in srgb, var(--color-black) 50%, transparent);
}
/* components.md's Confirmation modal frame, at its width; see the script note. */
.login-dialog {
  display: flex;
  flex-direction: column;
  gap: var(--space-settings);
  box-sizing: border-box;
  width: 326px;
  max-width: 100%;
  padding: var(--space-modal-margin);
  border: var(--border-heavy);
  border-radius: var(--radius-default);
  color: var(--color-cream);
  background: var(--color-panel-deep);
  box-shadow: var(--elevation-5);
}
.login-dialog:focus {
  outline: none;
}
.login-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-settings);
}
.login-title {
  margin: 0;
  color: var(--color-accent);
  font: inherit;
  font-size: var(--text-headline);
  overflow-wrap: anywhere;
}
.login-close {
  padding: 0;
  border: 0;
  color: var(--color-cream);
  cursor: pointer;
  background: transparent;
  font: inherit;
  font-size: var(--text-title);
  line-height: 1;
}
.login-message,
.login-instructions,
.login-url {
  margin: 0;
  color: var(--color-cream);
  font-size: var(--text-helper);
  line-height: 1.4;
  overflow-wrap: anywhere;
}
/* Empty while idle, so it takes no room but stays a live region throughout. */
.login-status {
  margin: 0;
  color: var(--color-cream);
  font-size: var(--text-meta);
}
.login-status:empty {
  display: none;
}
.login-error {
  margin: 0;
  padding: 7px 8px;
  border-left: 3px solid var(--danger-line);
  border-radius: 4px;
  color: var(--danger-ink);
  background: var(--danger-bg);
  font-size: var(--text-helper);
  line-height: 1.4;
}
.login-key-form,
.login-code-form,
.login-methods,
.login-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.login-label {
  margin: 0;
  color: var(--color-cream);
  font-size: var(--text-meta);
}
.login-input {
  padding: 6px var(--space-settings);
  border: var(--border-active);
  border-radius: var(--radius-default);
  color: var(--color-cream);
  background: var(--color-control);
  font: inherit;
  font-size: var(--text-meta);
}
.login-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-nav-gap);
}
/* The shared button model (components.md), as the Confirmation modal's Confirm uses it. */
.login-button {
  align-self: flex-start;
  padding: 6px 16px;
  border: var(--border-active);
  border-radius: var(--radius-default);
  color: var(--color-cream);
  cursor: pointer;
  background: var(--color-control);
  font: inherit;
  font-size: var(--text-meta);
}
.login-button:disabled {
  cursor: default;
  border: 2px solid var(--color-control-disabled);
  color: var(--color-control-disabled);
  background: var(--color-panel-deep);
}
.login-link {
  color: var(--color-accent);
  font-size: var(--text-helper);
  overflow-wrap: anywhere;
}
.login-close:focus-visible,
.login-button:focus-visible,
.login-input:focus-visible,
.login-link:focus-visible {
  outline: 2px solid var(--color-cream);
  outline-offset: 2px;
}
</style>
