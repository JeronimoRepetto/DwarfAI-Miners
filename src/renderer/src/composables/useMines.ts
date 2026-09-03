import { reactive } from 'vue'
import { defaultMinesState, type MinesSnapshot } from '../types'

// Singleton store: module-scope state shared by every useMines() caller
// (house style shared with a sibling Vue project).
const state = reactive(defaultMinesState())

/**
 * Every dwarf id the last snapshot carried, or null before the first one.
 *
 * Null and empty are different facts (#156): null is "the panel has not looked
 * yet", so nothing on the next snapshot is an arrival; empty is "the panel
 * looked and the valley was idle", so the next session to start IS one. Kept
 * outside `state` because nothing renders it — it exists only to answer what
 * changed between two snapshots.
 */
let previousDwarfIds: Set<string> | null = null

function dwarfIdsIn(snapshot: MinesSnapshot): Set<string> {
  const ids = new Set<string>()
  for (const mine of snapshot.mines) {
    for (const dwarf of mine.dwarfs) ids.add(dwarf.id)
  }
  return ids
}

export function useMines() {
  function setMines(snapshot: MinesSnapshot): void {
    const ids = dwarfIdsIn(snapshot)
    state.arrived =
      previousDwarfIds === null
        ? new Set()
        : new Set([...ids].filter((id) => !previousDwarfIds!.has(id)))
    previousDwarfIds = ids
    state.mines = snapshot.mines
    state.tokensObserved = snapshot.tokensObserved
    // Carried through as published, undefined included: an older snapshot with
    // no breakdown is an empty vault the panel can render, not a fault.
    state.materials = snapshot.materials
  }

  function clear(): void {
    state.mines = []
    state.tokensObserved = 0
    state.materials = undefined
    // Back to "has not looked": what the panel sees next is a first snapshot
    // again, not a valley of arrivals.
    state.arrived = new Set()
    previousDwarfIds = null
  }

  return { state, setMines, clear }
}
