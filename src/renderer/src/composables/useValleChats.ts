/*
 * The chats inside Valle's pins and panes (a Valle package gap resolved in development, EPIC-20 task TVC; 07 machines
 * 18, 29, 30; US-VALLE-007, US-VALLE-008): each pin's chat is the Panel's own MessagePanel or Add panel (BR-21), fed by
 * the window's one message dock (`useMessageDock`, ADR-033 item 5: each mode window its own singletons), as Veta's risen
 * window is.
 *
 * - The dock holds one open chat and one launch. The pins on screen (the Control room's expanded line, the Work front's
 *   one or two panes) are its `shown` chats, each drawn from the same stores; its open chat is the one in focus, which
 *   its paging follows.
 * - The launch serves the Add pin in focus, else an Add pin on screen, else the Add pin it already serves while that pin
 *   stays pinned, so a prompt half-typed survives a fold or a focus move; a launch that started its dwarf turns its Add
 *   pin into that dwarf's chat (S29.17).
 * - Drafts are the dock's, one per dwarf, for this window's run only (ADR-024; decision log, Drafts per dwarf): a pin
 *   folded, unfolded, moved between presets or panes takes its own back, and two panes never share one.
 * - The asks the panels draw and answer are the window's dual-source read model (`useDwarfQuestion`, ISSUE-138),
 *   followed while Valle lives; an answer leaves through the same broker path as the Panel's (ADR-010).
 * - The failed sends a hosted history marks are the dock's record of the send, as the Panel's are (#635).
 *
 * Nothing here raises a toast or plays a sound: the board's arrival toast stays Valle's own (`useValleArrivalToast`).
 */
import type { DwarfId, MineId } from '@dwarfai/contracts'
import { computed, onBeforeUnmount, onMounted, watch } from 'vue'
import type { Pin, PinInput, PinKey, PinSet } from '../lib/valle/pins'
import type { FailedSend } from '../types'
import { useDwarfQuestion } from './useDwarfQuestion'
import { useMessageDock } from './useMessageDock'

export interface ValleChatsDeps {
  /** The pin set (`useVallePins`). */
  pins(): PinSet
  /** Steps machine 29 (`useVallePins.send`, through the split). */
  send(input: PinInput): boolean
  /** The pins whose chats are on screen: the Control room's expanded line, the Work front's pane or panes. */
  shown(): readonly PinKey[]
}

/** What the dock is asked to hold: the launch on a mine, the open chat on a dwarf, or nothing. */
type DockTarget =
  | { readonly kind: 'launch'; readonly mineId: string }
  | { readonly kind: 'message'; readonly mineId: string; readonly dwarfId: string }
  | { readonly kind: 'none' }

export function useValleChats(deps: ValleChatsDeps) {
  const pinOf = (key: PinKey | null): Pin | undefined =>
    key === null ? undefined : deps.pins().pins.find((pin) => pin.key === key)
  const onScreen = computed((): readonly Pin[] => deps.shown().flatMap((key) => pinOf(key) ?? []))

  const dock = useMessageDock({
    shown: () => onScreen.value.flatMap((pin) => (pin.kind === 'chat' ? [pin.dwarfId] : []))
  })
  const { startAsks, stopAsks } = useDwarfQuestion()

  const addPinned = (mineId: string): boolean =>
    deps.pins().pins.some((pin) => pin.kind === 'add' && pin.mineId === mineId)

  /** The launch keeps its Add pin while it is pinned; then the focused chat is the open one. */
  const target = computed((): DockTarget => {
    const focus = pinOf(deps.pins().focus)
    if (focus?.kind === 'add') return { kind: 'launch', mineId: focus.mineId }
    const addShown = onScreen.value.find((pin) => pin.kind === 'add')
    if (addShown !== undefined) return { kind: 'launch', mineId: addShown.mineId }
    const serving = dock.launch.mineId.value
    if (dock.launchOpen.value && serving !== null && addPinned(serving)) {
      return { kind: 'launch', mineId: serving }
    }
    if (focus?.kind === 'chat') {
      return { kind: 'message', mineId: focus.mineId, dwarfId: focus.dwarfId }
    }
    return { kind: 'none' }
  })

  watch(
    target,
    (next) => {
      const now = dock.surface.value
      if (next.kind === 'launch') {
        if (now.surface !== 'launch' || now.mineId !== next.mineId) dock.openLaunch(next.mineId)
      } else if (next.kind === 'message') {
        if (now.surface !== 'message' || now.dwarfId !== next.dwarfId) {
          dock.openMessage(next.mineId, next.dwarfId)
        }
      } else if (now.surface !== 'none') dock.close()
    },
    { immediate: true }
  )

  // S29.17: the launch sent from an Add pin started its dwarf; the pin becomes that dwarf's chat.
  watch(
    () => dock.launch.state.value.launchedDwarfId,
    (dwarfId) => {
      const mineId = dock.launch.mineId.value
      if (dwarfId === null || mineId === null) return
      deps.send({ kind: 'launched', mineId: mineId as MineId, dwarfId: dwarfId as DwarfId })
    }
  )

  /** The failed sends a hosted mine history marks (#635): the dock's own record. */
  const failed = computed((): Record<string, FailedSend[]> => dock.delivery.value.failed ?? {})

  onMounted(() => {
    void startAsks()
  })
  onBeforeUnmount(stopAsks)

  return { dock, failed }
}
