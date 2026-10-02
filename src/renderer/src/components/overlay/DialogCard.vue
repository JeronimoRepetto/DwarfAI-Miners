<script setup lang="ts">
/*
 * The dialog's card (#635), `molecules/dialog` in the design: a raised wood card, its title, the
 * body the caller hands in, then the actions, Cancel first. A typed confirmation adds the line
 * Type "<word>" to confirm over a field, and every confirming action stays disabled until the field
 * holds the word; Enter in the field confirms only then. ModalDialog puts this over its scrim and
 * owns focus; drawn `static`, it is the card in place, as the UI kit states draw it.
 */
import { computed, ref } from 'vue'
import ActionButton from '../controls/ActionButton.vue'
import InputField from '../controls/InputField.vue'
import {
  dialogClasses,
  typedMatches,
  typedPlaceholder,
  typedPrompt,
  type DialogAction
} from '../../lib/overlay/dialog'

const props = withDefaults(
  defineProps<{
    title: string
    actions: DialogAction[]
    danger?: boolean
    wide?: boolean
    static?: boolean
    /** A body that is one plain sentence; anything richer goes in the default slot. */
    body?: string
    /** The word a typed confirmation asks for. */
    typed?: string
  }>(),
  { danger: false, wide: false, static: false, body: undefined, typed: undefined }
)
const emit = defineEmits<{ action: [index: number] }>()

const word = ref('')
const matched = computed(() => props.typed === undefined || typedMatches(word.value, props.typed))
const classes = computed(() =>
  dialogClasses({ danger: props.danger, wide: props.wide, static: props.static })
)

const held = (action: DialogAction): boolean =>
  action.disabled === true || (action.confirms === true && !matched.value)

function enter(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || !matched.value) return
  const at = props.actions.findIndex((action) => action.confirms === true && !held(action))
  if (at >= 0) emit('action', at)
}
</script>

<template>
  <div :class="classes" role="dialog" :aria-modal="static ? undefined : 'true'" :aria-label="title">
    <h2 class="dm-dialog__title">{{ title }}</h2>
    <div class="dm-dialog__body">
      <p v-if="body !== undefined">{{ body }}</p>
      <slot />
      <div v-if="typed !== undefined" class="dm-dialog__typed" @keydown="enter">
        {{ typedPrompt(typed)
        }}<InputField
          :placeholder="typedPlaceholder(typed)"
          :value="word"
          @update:value="word = $event"
        />
      </div>
    </div>
    <div class="dm-dialog__actions">
      <ActionButton
        v-for="(action, index) in actions"
        :key="index"
        :label="action.label"
        :variant="action.variant"
        :disabled="held(action)"
        @click="emit('action', index)"
      />
    </div>
  </div>
</template>

<style scoped>
/*
 * The design's dialog.css, rule for rule, plus the owner's rule (2026-10-02): a popup never scrolls sideways, its text
 * wraps to the card whatever its words (a long COPY NEEDED marker, real copy, a translation). The card keeps the
 * design's width bounds; its one column is never wider than the card (`minmax(0, 1fr)`, where the implicit `auto`
 * column grew to the widest unbreakable line); the title, the body and the action labels wrap, a long word included,
 * where a button keeps one line by default (ActionButton `nowrap`); and nothing scrolls sideways. The scrim is
 * ModalDialog's.
 */
.dm-dialog {
  --mat-fill: var(--wood);
  --mat-hi: var(--wood-hi);
  --mat-lo: var(--wood-lo);
  --mat-edge: var(--parchment);
  width: min(380px, 100%);
  max-height: calc(100vh - 32px);
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 14px;
  padding: 18px 18px 14px;
  overflow-x: hidden;
  overflow-y: auto;
}
.dm-dialog--wide {
  width: min(520px, 100%);
}
.dm-dialog__title {
  font: var(--fs-title) / 1.15 var(--f-display);
  color: var(--gold);
  overflow-wrap: anywhere;
}
.dm-dialog--danger {
  --mat-edge: var(--danger);
}
.dm-dialog--danger .dm-dialog__title {
  color: var(--danger-hi);
}
.dm-dialog__body {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 10px;
  overflow-wrap: anywhere;
  font: var(--fs-body) / 1.4 var(--f-talk);
  color: var(--ink);
}
.dm-dialog__body :deep(b) {
  color: var(--parch-hi);
}
.dm-dialog__actions {
  display: flex;
  gap: 8px;
  padding-top: 4px;
  justify-content: flex-end;
  flex-wrap: wrap;
}
.dm-dialog__actions :deep(.dm-btn) {
  max-width: 100%;
  white-space: normal;
  overflow-wrap: anywhere;
  line-height: 1.2;
  text-align: center;
}
.dm-dialog__typed {
  display: grid;
  gap: 4px;
  font: var(--fs-body) / 1.3 var(--f-meta);
  color: var(--parchment);
}
</style>
