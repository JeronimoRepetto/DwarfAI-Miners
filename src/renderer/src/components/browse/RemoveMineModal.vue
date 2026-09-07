<script setup lang="ts">
import { useId } from 'vue'

/**
 * The confirmation for removing one mine (#169).
 *
 * ## What the design source says, and what it does not
 *
 * `components.md`'s shared "Confirmation modal" is the geometry this reuses —
 * 326x265, centered, `#14100b` on a `4px #fae2b6` border, 12px radius and
 * margin, a `24px #d19831` title over a `12px #fae2b6` message, the close
 * glyph at the upper-right. The source only ever fills that shell in with
 * Settings' metrics wipe, and it specifies no per-mine removal anywhere; the
 * amendment is recorded in `screens/browse.md`'s Mine card section.
 *
 * The typed `yes` is deliberately NOT reused. That gate exists because the
 * metrics wipe is irreversible (screens/settings.md), and this is the one
 * destructive action in the app that is not: the row stays, the ore stays, and
 * adding the folder again brings the mine back. Asking a user to type a word
 * would tell them otherwise, so the copy says what actually happens instead.
 *
 * Presentational, like ResetMetricsModal: `removing` and `error` are main's
 * verdict, arriving through MinesPanel from useProjectBrowse, and the only
 * thing that leaves here is the confirmed intent.
 */
const props = defineProps<{
  /** The mine's display name, so the confirmation names what it is about. */
  name: string
  /** True while main is carrying the removal out; locks Confirm. */
  removing: boolean
  /** Why the last attempt failed, shown as an alert. Null when nothing has gone wrong. */
  error: string | null
}>()

const emit = defineEmits<{
  confirm: []
  close: []
}>()

const titleId = useId()

function onConfirm(): void {
  // A destructive action must not fire twice on a double press, and the
  // disabled attribute alone is not the guard — a keyboard Enter on a control
  // that was enabled a frame ago would still arrive here.
  if (props.removing) return
  emit('confirm')
}
</script>

<template>
  <div
    class="remove-modal"
    role="dialog"
    :aria-labelledby="titleId"
    @keydown.escape="emit('close')"
  >
    <header class="modal-head">
      <h2 :id="titleId" class="modal-title">Remove mine</h2>
      <button class="modal-close" type="button" aria-label="Close" @click="emit('close')">
        &times;
      </button>
    </header>
    <p class="modal-message">
      Stop tracking {{ name }}? It leaves the map and this list. Everything it has mined is kept,
      and adding the folder again brings the mine back.
    </p>
    <p v-if="error" class="modal-error" role="alert">{{ error }}</p>
    <button class="modal-confirm" type="button" :disabled="removing" @click="onConfirm">
      Remove
    </button>
  </div>
</template>

<style scoped>
/* components.md's Confirmation modal, positioned over the Mines panel it
   belongs to (`position: relative` there) — the same overlay approach
   ResetMetricsModal uses inside Settings. */
.remove-modal {
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
  /* The mine's name can be any folder name, and the panel is 276px wide at its
     minimum: without this the name pushes the modal's own box wider. */
  overflow-wrap: anywhere;
  color: var(--color-cream);
  font-size: var(--text-helper);
  line-height: 1.4;
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
/* The shared button model (components.md), the same one Reset metrics' Confirm
   draws — this one has no typed gate in front of it, so it is enabled until
   main is actually working on the removal. */
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
