import type { Mine } from '../../shared/contracts'

/** Renderer uses the shared IPC contract instead of maintaining a drift-prone copy. */
export type {
  Dwarf,
  DwarfActivation,
  DwarfProvider,
  DwarfRole,
  DwarfStatus,
  DwarfTextRequest,
  DwarfTextResult,
  FeedMessage,
  Mine,
  MineTier,
  TextDeliveryChannel
} from '../../shared/contracts'

/** Root state for the mines store. */
export interface MinesState {
  mines: Mine[]
}

export function defaultMinesState(): MinesState {
  return { mines: [] }
}

/**
 * What the panel shows about one dwarf's most recent message: in flight, or
 * the verdict, kept just long enough to be read.
 */
export interface DwarfSendState {
  phase: 'sending' | 'delivered' | 'failed'
  /** The channel the delivery used, once one was chosen. */
  via?: string
  /** Why it failed, shown on the marker. */
  error?: string
}

/** Root state for the dwarf-messaging store, keyed by dwarf id. */
export interface DwarfMessagingState {
  byDwarfId: Record<string, DwarfSendState>
}

export function defaultDwarfMessagingState(): DwarfMessagingState {
  return { byDwarfId: {} }
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
