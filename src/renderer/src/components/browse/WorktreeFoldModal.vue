<script setup lang="ts">
import { computed, useId } from 'vue'
import { worktreeQuestionBody } from '../../lib/worktree'
import type { MineWorktreeOf } from '../../types'

/**
 * The question asked when the folder somebody picked is a worktree (#348).
 *
 * ## What it is, and what it deliberately is not
 *
 * The confirmation modal's own shell, exactly as `RemoveMineModal` reuses it —
 * `components.md`'s 4px accent border, 12px radius and margin, the accent
 * title over the cream message, the close glyph at the upper-right. The
 * maintainer's amendment for this dialog is recorded in the design source; the
 * shell is the shared one either way.
 *
 * NOT a removal, so it does not borrow the destructive posture: nothing is
 * flagged and nothing is lost by cancelling, and the primary control says what
 * it does rather than asking for a confirmation of something already decided.
 *
 * There is no third answer, and that is the product decision rather than an
 * omission: declaring the WORKTREE is not on offer, because the board folds
 * every worktree into its project and a row for one would name a folder that
 * never appears as a mine.
 *
 * Presentational, like the modal beside it: `adding` is main's own state,
 * arriving through MinesPanel from useProjectBrowse, and the only things that
 * leave here are the two answers.
 */
const props = defineProps<{
  /** The picked worktree and the project behind it, as main resolved them. */
  worktreeOf: MineWorktreeOf
  /** True while main is adopting the project; locks the primary control. */
  adding: boolean
}>()

const emit = defineEmits<{
  open: []
  close: []
}>()

const titleId = useId()

const body = computed(() => worktreeQuestionBody(props.worktreeOf))

function onOpen(): void {
  // A second press while main is already adopting would ask for a project main
  // has stopped holding — the disabled attribute alone is not the guard, since
  // a keyboard Enter on a control enabled a frame ago still arrives here.
  if (props.adding) return
  emit('open')
}
</script>

<template>
  <div
    class="worktree-modal"
    role="dialog"
    :aria-labelledby="titleId"
    @keydown.escape="emit('close')"
  >
    <header class="modal-head">
      <h2 :id="titleId" class="modal-title">This folder is a worktree</h2>
      <button class="modal-close" type="button" aria-label="Close" @click="emit('close')">
        &times;
      </button>
    </header>
    <p class="modal-message">{{ body }}</p>
    <div class="modal-actions">
      <button class="modal-open" type="button" :disabled="adding" @click="onOpen">
        Open the main project
      </button>
      <button class="modal-cancel" type="button" @click="emit('close')">Cancel</button>
    </div>
  </div>
</template>

<style scoped>
/* components.md's Confirmation modal, positioned over the Mines panel it
   belongs to (`position: relative` there) — the same overlay RemoveMineModal
   uses, and the same geometry. */
.worktree-modal {
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
.modal-open:focus-visible,
.modal-cancel:focus-visible {
  outline: 2px solid var(--color-cream);
  outline-offset: 2px;
}
.modal-message {
  margin: 0;
  /* A worktree's folder name and a project's whole path both appear here, and
     the panel is 276px wide at its minimum: without this either would push the
     modal's own box wider. */
  overflow-wrap: anywhere;
  color: var(--color-cream);
  font-size: var(--text-helper);
  line-height: 1.4;
}
.modal-actions {
  display: flex;
  gap: var(--space-nav-gap);
  align-items: center;
  margin-top: auto;
}
/* The shared button model (components.md), the same one RemoveMineModal's
   Remove draws. */
.modal-open,
.modal-cancel {
  padding: 6px 16px;
  border: var(--border-active);
  border-radius: var(--radius-default);
  color: var(--color-cream);
  cursor: pointer;
  background: var(--color-control);
  font: inherit;
  font-size: var(--text-meta);
}
/* Cancel is the quiet half of the pair: the same model, without the filled
   surface that marks the action this dialog is actually offering. */
.modal-cancel {
  border: 2px solid var(--color-control);
  background: transparent;
}
.modal-open:disabled {
  cursor: default;
  border: 2px solid var(--color-control);
  color: var(--color-control);
  background: var(--color-panel-deep);
}
</style>
