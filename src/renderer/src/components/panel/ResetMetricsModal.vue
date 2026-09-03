<script setup lang="ts">
import { computed, onMounted, ref, useId } from 'vue'
import { isValidResetConfirmation } from '../../lib/settings/resetConfirmation'

/**
 * The typed reset-metrics confirmation modal (#138) — components.md's shared
 * "Confirmation modal" spec, filled in with screens/settings.md's Data Base
 * copy. 326x265, centered, `#14100b`/`4px #fae2b6` border per components.md;
 * those live in the scoped style below rather than as size props, because
 * this modal has exactly one design and nothing else mounts it.
 *
 * Presentational, like ShortcutSettings: `confirming`/`error` are main's
 * verdict (via useResetMetrics, owned by App.vue/SettingsPanel), and the
 * typed text is local state that never has to leave this component — only
 * the already-validated intent to reset does, as `confirm`.
 */
const props = defineProps<{
  /** True while main is processing a confirmed reset; locks input and Confirm. */
  confirming: boolean
  /** Why the last attempt failed, shown as an alert. Null when nothing has gone wrong. */
  error: string | null
}>()

const emit = defineEmits<{
  confirm: []
  close: []
}>()

const titleId = useId()
const typed = ref('')
const inputRef = ref<HTMLInputElement | null>(null)

const canConfirm = computed(() => !props.confirming && isValidResetConfirmation(typed.value))

function onConfirm(): void {
  if (!canConfirm.value) return
  emit('confirm')
}

// A keyboard user landing on the modal starts in the one control that matters.
onMounted(() => inputRef.value?.focus())
</script>

<template>
  <div class="reset-modal" role="dialog" :aria-labelledby="titleId" @keydown.escape="emit('close')">
    <header class="modal-head">
      <h2 :id="titleId" class="modal-title">Reset metrics</h2>
      <button class="modal-close" type="button" aria-label="Close" @click="emit('close')">
        &times;
      </button>
    </header>
    <p class="modal-message">Are you sure you want to delete your data? Type "yes" to confirm.</p>
    <input
      ref="inputRef"
      v-model="typed"
      class="modal-input"
      type="text"
      autocomplete="off"
      :disabled="confirming"
      @keydown.enter="onConfirm"
    />
    <p v-if="error" class="modal-error" role="alert">{{ error }}</p>
    <button class="modal-confirm" type="button" :disabled="!canConfirm" @click="onConfirm">
      Confirm
    </button>
  </div>
</template>

<style scoped>
/* components.md's Confirmation modal: 326x265, centered, #14100b, 4px cream
   border, 12px radius/margin. Positioned over the settings panel it belongs
   to (`position: relative` there), the same overlay approach FeedModal uses
   for its own centered dialog. */
.reset-modal {
  position: absolute;
  z-index: 96;
  inset: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-settings);
  width: 326px;
  height: 265px;
  margin: auto;
  padding: var(--space-modal-margin);
  border: var(--border-heavy);
  border-radius: var(--radius-default);
  background: var(--color-panel-deep);
  box-shadow: var(--elevation-5);
}
.modal-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
}
.modal-title {
  margin: 0;
  color: var(--color-accent);
  font: inherit;
  font-size: var(--text-headline);
}
.modal-close {
  padding: 0;
  border: 0;
  color: var(--color-cream);
  cursor: pointer;
  background: transparent;
  font: inherit;
  font-size: var(--text-title);
  line-height: 1;
}
.modal-close:focus-visible,
.modal-confirm:focus-visible {
  outline: 2px solid var(--color-cream);
  outline-offset: 2px;
}
.modal-message {
  margin: 0;
  color: var(--color-cream);
  font-size: var(--text-helper);
  line-height: 1.4;
}
.modal-input {
  padding: 6px var(--space-settings);
  border: var(--border-active);
  border-radius: var(--radius-default);
  color: var(--color-cream);
  background: var(--color-control);
  font: inherit;
  font-size: var(--text-meta);
}
.modal-input:disabled {
  cursor: default;
  opacity: 0.6;
}
.modal-error {
  margin: 0;
  padding: 7px 8px;
  border-left: 3px solid var(--danger-line);
  border-radius: 4px;
  color: var(--danger-ink);
  background: var(--danger-bg);
  font-size: var(--text-helper);
  line-height: 1.4;
}
/* Confirm reuses the shared button model (components.md): disabled fades to
   the deep background until the typed text is a valid confirmation. */
.modal-confirm {
  align-self: flex-start;
  margin-top: auto;
  padding: 6px 16px;
  border: var(--border-active);
  border-radius: var(--radius-default);
  color: var(--color-cream);
  cursor: pointer;
  background: var(--color-control);
  font: inherit;
  font-size: var(--text-meta);
}
.modal-confirm:disabled {
  cursor: default;
  border: 2px solid var(--color-control);
  color: var(--color-control);
  background: var(--color-panel-deep);
}
</style>
