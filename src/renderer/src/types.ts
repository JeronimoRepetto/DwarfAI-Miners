import type { Mine } from '../../shared/contracts'

/** Renderer uses the shared IPC contract instead of maintaining a drift-prone copy. */
export type {
  Dwarf,
  DwarfActivation,
  DwarfProvider,
  DwarfRole,
  DwarfStatus,
  FeedMessage,
  Mine,
  MineTier
} from '../../shared/contracts'

/** Root state for the mines store. */
export interface MinesState {
  mines: Mine[]
}

export function defaultMinesState(): MinesState {
  return { mines: [] }
}

/** Where the panel currently is: the isometric map, or inside one mine. */
export type View = { kind: 'map' } | { kind: 'mine'; mineId: string }

/** Root state for the navigation store. */
export interface ViewState {
  view: View
}

export function defaultViewState(): ViewState {
  return { view: { kind: 'map' } }
}
