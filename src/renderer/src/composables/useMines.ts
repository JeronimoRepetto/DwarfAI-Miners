import { reactive } from 'vue'
import { defaultMinesState, type MinesSnapshot } from '../types'

// Singleton store: module-scope state shared by every useMines() caller
// (house style shared with the sibling AI-Tools Vue tools).
const state = reactive(defaultMinesState())

export function useMines() {
  function setMines(snapshot: MinesSnapshot): void {
    state.mines = snapshot.mines
    state.tokensObserved = snapshot.tokensObserved
  }

  function clear(): void {
    state.mines = []
    state.tokensObserved = 0
  }

  return { state, setMines, clear }
}
