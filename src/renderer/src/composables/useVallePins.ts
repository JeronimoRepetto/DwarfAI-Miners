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
  type FocusRequest,
  type PinEffect,
  type PinInput,
  type PinSet,
  type PinView
} from '../lib/valle/pins'
import { restorePins } from '../lib/valle/restore'
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
}

export interface VallePinsPart {
  set: Readonly<Ref<PinSet>>
  /** The pins in order, with their words. */
  views: Readonly<Ref<readonly PinView[]>>
  /** Where keyboard focus goes next (after an unpin). */
  focusRequest: Readonly<Ref<FocusRequest | null>>
  /** Steps machine 29; answers whether the input was taken. */
  send(input: PinInput): boolean
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
        bridge.patchUiSession({ kind: 'current-mine', host: 'valle', mineId: effect.mineId })
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
      return
    }
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

  return { set, views, focusRequest, send }
}
