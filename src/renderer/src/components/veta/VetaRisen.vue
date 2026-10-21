<script setup lang="ts">
/*
 * The window risen above the Veta strip (`.dm-vwin`, DS/docs/screens/veta.md V3 and Layout; 07 machine 24; UC-048,
 * UC-066; ISSUE-290): the Panel's own MessagePanel on one dwarf, or the Panel's own Add panel aimed at a mine (BR-21:
 * the same components in every mode, fed by the same `useMessageDock`), anchored by its stepped pointer to the dwarf or
 * button that opened it. It never moves and cannot be dragged, detached or resized: its place is `risenGeometry`'s,
 * 14 px from the strip, measured from the island's anchored end like the window around it.
 *
 * Its motion is `transform`/`opacity` only (DS/docs/motion.md, Veta chat rise): it rises from 6 px off the strip (12 px
 * on a side edge) in 140 ms (180 ms on a side edge), a replace is a fade with no travel in 140 ms, and it folds 4 px
 * toward the strip (8 px on a side edge) in 90 ms, holding its last frame until it is removed. Each motion ends on its
 * transition's end or on its watchdog (NFR-TIM-16); under reduced motion none plays. The window around it is grown
 * before a rise and shrunk after a fold, never during one (`useVetaRisen`).
 *
 * "▢ Open in the Panel" and the history request inside the chat are ISSUE-293's (S24.12, S24.13).
 */
import type { ChatViewState } from '@dwarfai/contracts'
import { computed, nextTick, onBeforeUnmount, ref, type CSSProperties } from 'vue'
import type { useMessageDock } from '../../composables/useMessageDock'
import { captureChatView, restoredScrollTop } from '../../lib/chat/chatViewState'
import { prefersReducedMotion } from '../../lib/scene/sceneMotion'
import { WATCHDOG_MARGIN_MS } from '../../lib/shell/motionTiming'
import { RISEN, type RisenGeometry, type RisenWindow } from '../../lib/veta/risenWindow'
import AddPanel from '../launch/AddPanel.vue'
import DwarfMessagePanel from '../message/DwarfMessagePanel.vue'

type MessageDock = ReturnType<typeof useMessageDock>

const props = defineProps<{
  machine: RisenWindow
  geometry: RisenGeometry | null
  edge: 'top' | 'bottom' | 'left' | 'right'
  end: 'start' | 'end'
  /** The island's thickness across its edge. */
  thickness: number
  /** The Panel's own conversation and launch, hosted unchanged. */
  dock: MessageDock
  /** The name of the mine the Add panel is aimed at. */
  addMineName: string
}>()

const emit = defineEmits<{
  /** The chat's draft as it is typed. */
  draft: [dwarfId: string, text: string]
  /** The panel's own close (its ×, or Esc inside it). */
  close: []
}>()

const root = ref<HTMLElement | null>(null)

/** Where the motion stands: placed off the strip, shown, veiled for a replace, or folded away. */
type Phase = 'before' | 'shown' | 'veiled' | 'folded'
const phase = ref<Phase>('before')

const side = computed(() => props.edge === 'left' || props.edge === 'right')

const style = computed<CSSProperties>(() => {
  const placed = props.geometry
  if (placed === null) return { visibility: 'hidden' }
  const at: CSSProperties = {
    width: `${placed.width}px`,
    height: `${placed.height}px`,
    '--ptr': `${placed.pointer}px`
  } as CSSProperties
  at[props.edge] = `${props.thickness + RISEN.gap}px`
  const anchored = side.value
    ? props.end === 'end'
      ? 'bottom'
      : 'top'
    : props.end === 'end'
      ? 'right'
      : 'left'
  at[anchored] = `${placed.fromAnchor}px`
  return at
})

const chatOpen = computed(
  () => props.machine.content?.kind === 'chat' && props.dock.selectedDwarf.value !== undefined
)
const addOpen = computed(() => props.machine.content?.kind === 'add' && props.dock.launchOpen.value)

/** The motion's length, from the design's tokens (`--dur-base`, `--dur-panel`, `--dur-fast`). */
function durationOf(kind: 'rise' | 'replace' | 'fold'): number {
  if (prefersReducedMotion()) return 0
  if (kind === 'fold') return 90
  return kind === 'rise' && side.value ? 180 : 140
}

let settle: (() => void) | null = null
let watchdog: ReturnType<typeof setTimeout> | null = null

function finish(): void {
  if (watchdog !== null) clearTimeout(watchdog)
  watchdog = null
  const done = settle
  settle = null
  done?.()
}

function ended(event: TransitionEvent): void {
  if (event.target === root.value && event.propertyName === 'opacity') finish()
}

/** One frame painted, so the next phase transitions from this one. */
const painted = (): Promise<void> =>
  new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve())
    else setTimeout(resolve, 16)
  })

/** Plays a motion; resolves when it ended, by its transition's end or its watchdog. */
async function play(kind: 'rise' | 'veil' | 'replace' | 'fold'): Promise<void> {
  finish()
  if (kind === 'veil') {
    phase.value = 'veiled'
    await nextTick()
    return
  }
  const ms = durationOf(kind)
  if (kind === 'rise') {
    phase.value = 'before'
    await nextTick()
    if (ms > 0) await painted()
  }
  phase.value = kind === 'fold' ? 'folded' : 'shown'
  if (ms === 0) {
    await nextTick()
    return
  }
  await new Promise<void>((resolve) => {
    settle = resolve
    watchdog = setTimeout(finish, ms + WATCHDOG_MARGIN_MS)
  })
}

/** The chat's composer, or the question card's first option while the dwarf asks; the Add panel's first chip. */
function focusContent(target: 'chat' | 'add'): void {
  const box = root.value
  if (box === null) return
  const field =
    target === 'add'
      ? box.querySelector<HTMLElement>('.dm-add__chips button:not([disabled])')
      : (box.querySelector<HTMLElement>('.dm-msg textarea:not([disabled])') ??
        box.querySelector<HTMLElement>('.dm-qcard .dm-qopt'))
  field?.focus({ preventScroll: true })
}

const list = (): HTMLElement | null =>
  root.value?.querySelector<HTMLElement>('.dm-msg__log') ?? null
const field = (): HTMLTextAreaElement | null =>
  root.value?.querySelector<HTMLTextAreaElement>('.dm-msg textarea') ?? null

/** The open chat's view state as the panel shows it (ADR-024 item 3). */
function captureView(): ChatViewState {
  return captureChatView(list() ?? { scrollTop: 0, scrollHeight: 0, clientHeight: 0 }, [], field())
}

/** Puts a stored view state back once the panel is drawn. */
async function restoreView(view: ChatViewState | null): Promise<void> {
  await nextTick()
  if (view === null) return
  const log = list()
  if (log !== null) log.scrollTop = restoredScrollTop(view.scrollAnchor, log, [])
  const composer = field()
  if (composer !== null && view.selection !== undefined) {
    const { start, end, direction } = view.selection
    composer.setSelectionRange(start, end, direction)
  }
}

onBeforeUnmount(finish)

defineExpose({ play, focusContent, captureView, restoreView })
</script>

<template>
  <div
    v-if="machine.content !== null"
    ref="root"
    class="veta-risen"
    :style="style"
    :data-edge="edge"
    :data-phase="phase"
    :data-state="machine.state"
    :data-shown="phase === 'shown' ? 'true' : 'false'"
    :data-content="machine.content.kind"
    data-veta-risen
    @transitionend="ended"
  >
    <span class="veta-risen__ptr" aria-hidden="true" />
    <DwarfMessagePanel
      v-if="chatOpen && dock.selectedDwarf.value"
      :key="dock.selectedDwarf.value.id"
      :dwarf="dock.selectedDwarf.value"
      :route-gone="dock.selectedRouteGone.value"
      :feed="dock.drawnFeed.value"
      :paging-note="dock.pagingNote.value ?? undefined"
      :draft="dock.drafts.value[dock.selectedDwarf.value.id]"
      :send-state="dock.messageStateFor(dock.selectedDwarf.value.id)"
      :echoes="dock.sentEchoes[dock.selectedDwarf.value.id]"
      :echo-attachments="dock.sentEchoAttachments[dock.selectedDwarf.value.id]"
      :stop-disabled="dock.stopDisabled(dock.selectedDwarf.value.id)"
      :answer-state="dock.questionState.byDwarfId[dock.selectedDwarf.value.id]"
      @draft="emit('draft', dock.selectedDwarf.value.id, $event)"
      @send="dock.sendText(dock.selectedDwarf.value, $event)"
      @retry="dock.retryMessage(dock.selectedDwarf.value, $event)"
      @copy="dock.copyMessage"
      @stop="dock.stopDwarf(dock.selectedDwarf.value)"
      @answer="dock.answerQuestion(dock.selectedDwarf.value, $event)"
      @answer-text="dock.answerQuestionInWords(dock.selectedDwarf.value, $event)"
      @decide="dock.decidePermission(dock.selectedDwarf.value, $event)"
      @open-console="dock.activate(dock.selectedDwarf.value)"
      @open-path="dock.openPath"
      @open-link="dock.openLink"
      @page-back="dock.pageBack"
      @close="emit('close')"
    />
    <AddPanel
      v-else-if="addOpen"
      :mine-name="addMineName"
      :chips="dock.launch.chips.value"
      :phase="dock.launch.phase.value"
      :enabled="dock.launch.enabled.value"
      :command="dock.launch.state.value.command"
      :prompt="dock.launch.state.value.prompt"
      :refusal="dock.launch.refusal.value"
      :error="dock.launch.state.value.error"
      :model-picker="dock.launch.modelPicker.value"
      :effort-picker="dock.launch.effortPicker.value"
      :permissions-visible="dock.launch.permissionsVisible.value"
      :jev="dock.launch.jev.value"
      :model="dock.launch.state.value.model"
      :effort="dock.launch.state.value.effort"
      :permission-mode="dock.launch.state.value.permissionMode"
      :failure="dock.launch.state.value.failure"
      :integration-notice="dock.launch.integrationNotice.value"
      :jev-accepted="dock.launch.jevAccepted.value"
      @enable-integration="dock.launch.enableIntegration"
      @choose="dock.launch.choose"
      @command="dock.launch.setCommand"
      @commit="dock.launch.commit"
      @prompt="dock.launch.setPrompt"
      @model="dock.launch.setModel"
      @effort="dock.launch.setEffort"
      @permission-mode="dock.launch.setPermissionMode"
      @toggle-jev="dock.launch.toggleJevEnabled"
      @toggle-jev-auto="dock.launch.toggleJevAutoAccept"
      @dismiss-jev="dock.launch.dismissJevDecision"
      @submit="dock.launch.submit"
      @retry="dock.launch.retry"
      @pick-manually="dock.launch.pickManually"
      @close="emit('close')"
    />
  </div>
</template>

<style scoped>
/* `.dm-vwin`: the risen window, its panel filling it. */
.veta-risen {
  position: absolute;
  z-index: 7;
  display: flex;
  box-sizing: border-box;
}

.veta-risen > :deep(.dm-msg),
.veta-risen > :deep(.dm-add) {
  width: 100%;
  height: 100%;
}

/* `.dm-vwin__ptr`: the stepped pointer at the dwarf or button that opened it, wood over a rock-lo shadow. */
.veta-risen__ptr {
  position: absolute;
  z-index: 1;
  width: 16px;
  height: 8px;
  pointer-events: none;
}

.veta-risen__ptr::before,
.veta-risen__ptr::after {
  position: absolute;
  top: 0;
  left: 0;
  width: 16px;
  height: 8px;
  content: '';
  background:
    linear-gradient(var(--c), var(--c)) 0 0 / 16px 2px no-repeat,
    linear-gradient(var(--c), var(--c)) 2px 2px / 12px 2px no-repeat,
    linear-gradient(var(--c), var(--c)) 4px 4px / 8px 2px no-repeat,
    linear-gradient(var(--c), var(--c)) 6px 6px / 4px 2px no-repeat;
}

.veta-risen__ptr::before {
  top: 2px;
  --c: var(--rock-lo);
}

.veta-risen__ptr::after {
  --c: var(--wood);
}

.veta-risen[data-edge='bottom'] .veta-risen__ptr {
  top: calc(100% + 2px);
  left: calc(var(--ptr) - 8px);
}

.veta-risen[data-edge='top'] .veta-risen__ptr {
  bottom: calc(100% + 2px);
  left: calc(var(--ptr) - 8px);
  transform: rotate(180deg);
}

.veta-risen[data-edge='right'] .veta-risen__ptr {
  top: calc(var(--ptr) - 4px);
  left: calc(100% - 2px);
  transform: rotate(-90deg);
}

.veta-risen[data-edge='left'] .veta-risen__ptr {
  top: calc(var(--ptr) - 4px);
  right: calc(100% - 2px);
  transform: rotate(90deg);
}

/* The motion (DS/docs/motion.md, Veta chat rise): `transform` and `opacity` only. */
.veta-risen[data-phase='before'] {
  opacity: 0;
  transform: translateY(6px);
}

.veta-risen[data-phase='before'][data-edge='top'] {
  transform: translateY(-6px);
}

.veta-risen[data-phase='before'][data-edge='left'] {
  transform: translateX(-12px);
}

.veta-risen[data-phase='before'][data-edge='right'] {
  transform: translateX(12px);
}

.veta-risen[data-phase='shown'] {
  opacity: 1;
  transform: none;
  transition:
    opacity var(--dur-base) var(--ease-out),
    transform var(--dur-base) var(--ease-out);
}

.veta-risen[data-phase='shown'][data-edge='left'],
.veta-risen[data-phase='shown'][data-edge='right'] {
  transition:
    opacity var(--dur-panel) var(--ease-out),
    transform var(--dur-panel) var(--ease-out);
}

/* A replace fades in with no travel, over the same 140 ms on every edge. */
.veta-risen[data-phase='shown'][data-state='replacing'] {
  transition: opacity var(--dur-base) var(--ease-out);
}

.veta-risen[data-phase='veiled'] {
  opacity: 0;
  transform: none;
}

.veta-risen[data-phase='folded'] {
  opacity: 0;
  transform: translateY(4px);
  pointer-events: none;
  transition:
    opacity var(--dur-fast) var(--ease-in),
    transform var(--dur-fast) var(--ease-in);
}

.veta-risen[data-phase='folded'][data-edge='top'] {
  transform: translateY(-4px);
}

.veta-risen[data-phase='folded'][data-edge='left'] {
  transform: translateX(-8px);
}

.veta-risen[data-phase='folded'][data-edge='right'] {
  transform: translateX(8px);
}

@media (prefers-reduced-motion: reduce) {
  .veta-risen {
    transition: none !important;
  }
}
</style>
