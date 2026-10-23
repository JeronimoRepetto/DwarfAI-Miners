/*
 * Valle's pinned chats wired to UI main (07 machines 18, 29; 14 §2.2 A-N18, A-N21, §3.9 `pins`,
 * `UiSessionSnapshot.valle`; ADR-024 items 1, 4; US-VALLE-007; ISSUE-302): the pin set (`pins.ts`) opened once the
 * Host's facts are read, stepped on each input, and every effect carried out.
 *
 * - Opening (once the Host's facts are first read): a stored set is restored in order (S29.02, `restorePins`), the
 *   session's Add pins and focused pin back in place; with no stored set (never written: a first visit, or after Reset
 *   metrics) the start-up pins apply (S29.01): the waiting dwarfs, oldest question first, then the chat talked to last.
 * - Every change writes the chat pins whole through A-N21 (`pins`, UI main the only writer of the store). A write UI main
 *   fails leaves the set in memory; the next change writes it whole again (S29.21; UI main logs
 *   `uiprefs.write-failed`). The focus, `openChat.valle`, the current mine, "talked to" and the Add pins go to the
 *   session through A-N18, never persisted (S29.22; PO #67).
 * - The Host's facts reach the set: a departure (S29.13, S29.14), a mine's removal (S29.14), and a re-snapshot after the
 *   Host came back, where a pinned dwarf no longer listed ended meanwhile. A fact heard during a drag lands once the drag
 *   ends, so nothing the Host said is lost to the `reordering` state.
 * - Reset metrics: the stores read again clear the set (S29.20); the next open is S29.01.
 * - A gone pin keeps the name this window last knew for its dwarf.
 * - A dive or a Work front swap (S29.12; ISSUE-301): `diveInput` binds the real tab order (`diveOrder.ts`) over the
 *   Host's facts now, the mine's waiting dwarfs and its crew in the Host's order, and the set's talked-to marks.
 *   `focused` tells how the chat in focus was focused, for the dwarf a dive is for (S28.03).
 *
 * The bridge is injected (the house idiom over `vi.mock`); the Valle root hands it the page's own bridge.
 */
import type {
  DwarfId,
  DwarfWire,
  MineId,
  MineWire,
  UiPreferencesMap,
  UiSessionPatch
} from '@dwarfai/contracts'
import { computed, getCurrentScope, onScopeDispose, shallowRef, watch, type Ref } from 'vue'
import {
  NO_PINS,
  pinViews,
  restoredPins,
  startUpPins,
  stepPins,
  type DiveOrder,
  type FocusRequest,
  type PinEffect,
  type PinInput,
  type PinSet,
  type PinView
} from '../lib/valle/pins'
import { restorePins } from '../lib/valle/restore'
import { diveOrder, type DiveFocus, type DiveFocusOrigin } from '../lib/valle/diveOrder'
import type { ValleFact } from '../lib/valle/valleReadModel'
import type { ValleStores } from './useValleStores'

/**
 * The pins write A-N21 takes from a renderer: the chat pins, never `null` (never written), which only Reset metrics
 * returns the store to (S29.20, UI main's own).
 */
export interface VallePinsWrite {
  key: 'pins'
  value: NonNullable<UiPreferencesMap['pins']>
}

/** The seam A members the pins use (14 A-N21 for `pins`, A-N18). */
export interface VallePinsBridge {
  setUiPreference(write: VallePinsWrite): Promise<unknown>
  patchUiSession(patch: UiSessionPatch): void
}

/** What the pins read of the Valle read model. */
export interface VallePinsModel {
  dwarfs: Readonly<Ref<readonly DwarfWire[]>>
  mines: Readonly<Ref<readonly MineWire[]>>
  askOf(dwarfId: DwarfId): 'question' | 'permission' | null
  onFacts(listener: (facts: readonly ValleFact[]) => void): () => void
}

export interface VallePinsDeps {
  bridge: VallePinsBridge
  /** The stores read before the first paint, read again after Reset metrics (`useValleStores`). */
  stores: Readonly<Ref<ValleStores>>
  model: VallePinsModel
  /** The Host's facts were read once: the set opens on them. */
  factsRead: Readonly<Ref<boolean>>
  /** The chat talked to last before Valle opened (07 N-16, §24 I-29), if any. */
  talkedLast(): DwarfId | null
  /**
   * The window's current mine (07 machine 35, S35.01; ISSUE-307): a focused chat's mine goes there, and the current mine
   * writes A-N18 `current-mine` itself (the Work front's S35.04 included). Without it the mine is written here.
   */
  chatFocused?(mineId: MineId): void
}

export interface VallePinsPart {
  set: Readonly<Ref<PinSet>>
  /** The pins in order, with their words. */
  views: Readonly<Ref<readonly PinView[]>>
  /** Where keyboard focus goes next (after an unpin). */
  focusRequest: Readonly<Ref<FocusRequest | null>>
  /** Steps machine 29; answers whether the input was taken. */
  send(input: PinInput): boolean
  /** The chat in focus and how it was focused, which the dive reads for the dwarf it is for (07 S28.03). */
  focused: Readonly<Ref<DiveFocus | null>>
  /** A dive or a Work front swap into `mineId` (07 S29.12), the real tab order bound. */
  diveInput(mineId: MineId, forDwarfId: DwarfId | null): PinInput
}

/**
 * How the chat in focus came to be focused after `input` (07 S28.03): a needs-you jump or entry (S29.19) from the queue,
 * a chat carried in from the Panel or Veta (S29.23) handed over; anything else that moves or touches the focus here.
 */
function originOf(input: PinInput, moved: boolean, was: DiveFocusOrigin): DiveFocusOrigin {
  if (input.kind === 'jump') return 'queue'
  if (input.kind === 'carried') return 'handover'
  return moved || input.kind === 'select' || input.kind === 'click' ? 'other' : was
}

/** The Host's facts the set hears; refused during a drag, they wait for its end. */
const HOST_FACTS = new Set<PinInput['kind']>(['departed', 'mine-removed'])

export function useVallePins(deps: VallePinsDeps): VallePinsPart {
  const { bridge, model } = deps
  const set = shallowRef<PinSet>(NO_PINS)
  const focusRequest = shallowRef<FocusRequest | null>(null)
  const names = new Map<DwarfId, string>()
  let opened = false
  let seq = 0
  let waiting: PinInput[] = []
  /** How the chat in focus was focused (07 S28.03): the session's carried chat counts as handed over (S29.23). */
  const origin = shallowRef<DiveFocusOrigin>('other')

  // A write UI main refuses or fails leaves the set in memory: the next change writes it whole (S29.21).
  const kept = (): void => {}
  function carry(effect: PinEffect): void {
    switch (effect.kind) {
      case 'write-pins':
        void bridge.setUiPreference({ key: 'pins', value: effect.pins }).catch(kept)
        return
      case 'session':
        bridge.patchUiSession({ kind: 'valle', patch: effect.patch })
        return
      case 'open-chat':
        bridge.patchUiSession({ kind: 'open-chat', host: 'valle', dwarfId: effect.dwarfId })
        return
      case 'current-mine':
        if (deps.chatFocused !== undefined) deps.chatFocused(effect.mineId)
        else bridge.patchUiSession({ kind: 'current-mine', host: 'valle', mineId: effect.mineId })
        return
      case 'keyboard-focus':
        focusRequest.value = { target: effect.target, seq: (seq += 1) }
        return
    }
  }

  function send(input: PinInput): boolean {
    const from = set.value
    const step = stepPins(from, input)
    if (!step.ok) {
      if (from.dragging !== null && HOST_FACTS.has(input.kind)) waiting.push(input)
      return false
    }
    set.value = step.set
    origin.value = originOf(input, from.focus !== step.set.focus, origin.value)
    step.effects.forEach(carry)
    if (from.dragging !== null && step.set.dragging === null && waiting.length > 0) {
      const heard = waiting
      waiting = []
      heard.forEach(send)
    }
    return true
  }

  const mineExists = (mineId: MineId): boolean =>
    model.mines.value.some((mine) => mine.id === mineId)
  const dwarfOf = (dwarfId: DwarfId): DwarfWire | undefined =>
    model.dwarfs.value.find((dwarf) => dwarf.id === dwarfId)

  /** S29.01 or S29.02, once the Host's facts are read. */
  function open(): void {
    opened = true
    const stores = deps.stores.value
    const restored = restorePins(stores.pins, {
      mineExists,
      // A dwarf the Host no longer lists ended meanwhile; a deleted row goes with Reset metrics, which clears the pins.
      dwarf: (dwarfId) => (dwarfOf(dwarfId) ? 'alive' : 'ended')
    })
    if (restored !== null) {
      set.value = restoredPins(restored, stores.session.valle)
      const carried = stores.session.valle.diveForDwarfId ?? null
      if (carried !== null && set.value.focus === carried) origin.value = 'handover'
      return
    }
    startUp()
  }

  /**
   * Owner ruling 2026-10-23 (VQA-07): the start-up pins stay pending while they found nobody to pin. An empty start-up
   * set writes nothing, so the store stays never written; until the set holds a pin, the start-up pins apply again as
   * the Host's dwarfs change (a first visit before any mine or dwarf exists). The first pin ends it for good.
   */
  let startUpPending = false

  /** S29.01 against the Host's facts now. */
  function startUp(): void {
    const last = deps.talkedLast()
    const lastDwarf = last === null ? undefined : dwarfOf(last)
    const startUp = startUpPins({
      needsYou: model.dwarfs.value
        .filter((dwarf) => dwarf.needsYou)
        .map((dwarf) => ({
          dwarfId: dwarf.id,
          mineId: dwarf.mineId,
          askedAt: dwarf.askedAt ?? dwarf.arrivedAt
        })),
      talkedLast:
        lastDwarf === undefined ? null : { dwarfId: lastDwarf.id, mineId: lastDwarf.mineId }
    })
    set.value = startUp.set
    startUp.effects.forEach(carry)
    startUpPending = startUp.set.pins.length === 0
  }

  /** After a re-snapshot: a pinned dwarf no longer listed ended meanwhile, or went with its mine (S29.13, S29.14). */
  function reconcile(): void {
    for (const pin of set.value.pins) {
      if (pin.kind !== 'chat' || pin.state !== 'live' || dwarfOf(pin.dwarfId)) continue
      send({ kind: 'departed', dwarfId: pin.dwarfId, mineRemoved: !mineExists(pin.mineId) })
    }
  }

  function heard(facts: readonly ValleFact[]): void {
    if (!opened) return
    for (const fact of facts) {
      if (fact.kind === 'departed') {
        send({ kind: 'departed', dwarfId: fact.dwarfId, mineRemoved: fact.mineRemoved })
      } else if (fact.kind === 'mine-removed') send({ kind: 'mine-removed', mineId: fact.mineId })
      else if (fact.kind === 'snapshot') reconcile()
    }
  }
  const stopFacts = model.onFacts(heard)

  watch(
    () => deps.factsRead.value,
    (read) => {
      if (read && !opened) open()
    },
    { immediate: true }
  )
  // The stores change only when read again after Reset metrics (S39.10): the set clears (S29.20).
  watch(
    () => deps.stores.value,
    () => {
      if (opened) send({ kind: 'reset' })
    }
  )
  // VQA-07 (owner ruling 2026-10-23): nobody was there to pin at the start-up; a dwarf arriving or asking may be.
  watch(
    () => model.dwarfs.value,
    () => {
      if (opened && startUpPending && set.value.pins.length === 0) startUp()
      else startUpPending = false
    }
  )
  // The names this window knew, for the pins whose dwarfs left.
  watch(
    () => model.dwarfs.value,
    (dwarfs) => {
      for (const dwarf of dwarfs) names.set(dwarf.id, dwarf.customName ?? dwarf.baseName)
    },
    { immediate: true }
  )
  if (getCurrentScope() !== undefined) onScopeDispose(stopFacts)

  const views = computed(() =>
    pinViews(set.value, {
      dwarf: (dwarfId) => {
        const dwarf = dwarfOf(dwarfId)
        if (dwarf === undefined) return null
        return {
          name: dwarf.customName ?? dwarf.baseName,
          status: dwarf.status,
          ask: model.askOf(dwarfId)
        }
      },
      mineName: (mineId) => model.mines.value.find((mine) => mine.id === mineId)?.name ?? null,
      knownName: (dwarfId) => names.get(dwarfId) ?? null
    })
  )

  const focused = computed((): DiveFocus | null => {
    const pin = set.value.pins.find((p) => p.key === set.value.focus)
    if (pin?.kind !== 'chat') return null
    return { dwarfId: pin.dwarfId, mineId: pin.mineId, from: origin.value }
  })

  /** S29.12 over the Host's facts now: the mine's waiting dwarfs, its crew in the Host's order, its talked-to mark. */
  function diveInput(mineId: MineId, forDwarfId: DwarfId | null): PinInput {
    const order: DiveOrder = (input) => {
      const crew = model.dwarfs.value.filter((dwarf) => dwarf.mineId === mineId)
      return diveOrder(input, {
        needing: crew
          .filter((dwarf) => dwarf.needsYou)
          .map((dwarf) => ({ dwarfId: dwarf.id, askedAt: dwarf.askedAt ?? dwarf.arrivedAt })),
        talkedTo: set.value.talkedTo[mineId] ?? null,
        crew: crew.map((dwarf) => dwarf.id)
      })
    }
    return { kind: 'dive', mineId, forDwarfId, order }
  }

  return { set, views, focusRequest, send, focused, diveInput }
}
