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
