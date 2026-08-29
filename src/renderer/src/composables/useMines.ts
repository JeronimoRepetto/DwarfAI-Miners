import { reactive } from 'vue'
import { defaultMinesState, type Mine } from '../types'

// Singleton store: module-scope state shared by every useMines() caller
// (house style shared with the sibling AI-Tools Vue tools).
const state = reactive(defaultMinesState())

export function useMines() {
  function setMines(mines: Mine[]): void {
    state.mines = mines
  }

  function clear(): void {
    state.mines = []
  }

  return { state, setMines, clear }
}
