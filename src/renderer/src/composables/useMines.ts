import { reactive } from 'vue'
import { defaultMinesState, type MinesSnapshot } from '../types'

// Singleton store: module-scope state shared by every useMines() caller
// (house style shared with a sibling Vue project).
const state = reactive(defaultMinesState())

export function useMines() {
  function setMines(snapshot: MinesSnapshot): void {
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
  }

  return { state, setMines, clear }
}
