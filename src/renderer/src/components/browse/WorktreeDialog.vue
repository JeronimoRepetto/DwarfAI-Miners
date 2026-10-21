<script setup lang="ts">
/*
 * The worktree question (#348; US-MINES-004.AC03, AC06, AC07): a folder picked by Add a mine turned out to be a
 * worktree of a project, so the app asks before adding anything. Title "<folder> is a worktree of <mine>", body "Its
 * dwarfs will work in <mine>.", actions Cancel (first) and "Add <mine>", which holds while the adoption runs so it
 * cannot fire twice. The words are lib/worktree's; the mine is a folder's name, drawn stripped and bidi-isolated
 * (C-08). Moved out of MinesList (ISSUE-288) so Veta's mine picker asks the same question.
 */
import { computed } from 'vue'
import ModalDialog from '../overlay/ModalDialog.vue'
import {
  WORKTREE_BODY_LEAD,
  WORKTREE_BODY_TAIL,
  worktreeMineName,
  worktreeQuestionAccept,
  worktreeQuestionTitle
} from '../../lib/worktree'
import type { MineWorktreeOf } from '../../types'

const props = withDefaults(
  defineProps<{
    /** The worktree picked and the project behind it, while the question is asked; `null` otherwise. */
    question: MineWorktreeOf | null
    /** True while the main project is being adopted. */
    adding?: boolean
  }>(),
  { adding: false }
)

const emit = defineEmits<{
  /** Cancel, Esc: nothing is added. */
  dismiss: []
  /** "Add <mine>": adopt the main project instead. */
  accept: []
}>()

const actions = computed(() => [
  { label: 'Cancel' },
  {
    label: props.question ? worktreeQuestionAccept(props.question) : '',
    variant: 'primary' as const,
    disabled: props.adding
  }
])

function action(index: number): void {
  if (index === 0) emit('dismiss')
  else if (!props.adding) emit('accept')
}
</script>

<template>
  <ModalDialog
    :open="question !== null"
    :title="question ? worktreeQuestionTitle(question) : ''"
    :actions="actions"
    @action="action"
    @cancel="emit('dismiss')"
  >
    <!-- The mine is a folder's name: stripped, and bidi-isolated (C-08). -->
    <p v-if="question">
      {{ WORKTREE_BODY_LEAD }}<bdi>{{ worktreeMineName(question) }}</bdi
      >{{ WORKTREE_BODY_TAIL }}
    </p>
  </ModalDialog>
</template>
