import type { MaterialTotals, Mine } from '../../shared/contracts'

/** Renderer uses the shared IPC contract instead of maintaining a drift-prone copy. */
export type {
  AppBuild,
  Dwarf,
  DwarfActivation,
  DwarfAttendance,
  DwarfCapabilities,
  DwarfKickRequest,
  DwarfKickResult,
  DwarfProvider,
  DwarfQuestion,
  DwarfQuestionOption,
  DwarfRole,
  DwarfStatus,
  DwarfTextRequest,
  DwarfTextResult,
  FeedMessage,
  Material,
  MaterialTotals,
  Mine,
  MineDeclareResult,
  MinesSnapshot,
  MineTier,
  MineUndeclareResult,
  ProjectQuery,
  ProjectQueryResult,
  ProjectSortDirection,
  ProjectSortKey,
  ProjectSummary,
  ShortcutState,
  TextDeliveryChannel,
  WaitingReason
} from '../../shared/contracts'

/**
 * The wire constants and helpers the renderer reads as VALUES, not just types,
 * so every renderer module keeps `../types` as its single import root into the
 * shared contract rather than reaching across the process boundary itself.
 * Anything the process needs that this list omits is a module reaching past the
 * barrel, so add it here rather than letting one absent value drag a whole
 * import statement across (#77).
 */
export {
  DWARF_SILENCE_WINDOW_MS,
  MATERIALS,
  MATERIAL_TOKENS_PER_UNIT,
  MAX_DWARF_TEXT_CHARS,
  MINE_TIERS,
  WAITING_ON_HUMAN_REASON,
  dwarfSilenceWindowMs,
  isMineTier
} from '../../shared/contracts'

/** Root state for the mines store. */
export interface MinesState {
  mines: Mine[]
  /** Sum of every mine's tokensObserved — the vault total for the map-view chip. */
  tokensObserved: number
  /**
   * The whole vault by material, for the map-view breakdown (see #22).
   *
   * Deliberately NOT the sum of `mines[].materials`: main sums it over the
   * entire persisted ledger, so it includes projects with no crew today — which
   * is the only place backfilled coal can appear. Undefined until the first
   * snapshot that carries one, since the wire field is optional.
   */
  materials?: MaterialTotals
}

export function defaultMinesState(): MinesState {
  return { mines: [], tokensObserved: 0 }
}

/**
 * What the panel shows about one dwarf's most recent message: in flight, or
 * the verdict, kept just long enough to be read.
 *
 * 'delivered' and 'reacted' are two different facts, and the panel must never
 * blur them (issue #21): delivered means the text reached the session's queue,
 * reacted means the session was then SEEN acting on it. A delivery that is
 * never observed reacting stays 'delivered' — it never promotes on a guess.
 */
export interface DwarfSendState {
  phase: 'sending' | 'delivered' | 'reacted' | 'failed'
  /** The channel the delivery used, once one was chosen. */
  via?: string
  /** Why it failed, shown on the marker. */
  error?: string
  /**
   * True while a delivered message is still watching its dwarf's snapshots for
   * proof the session acted. False once that bounded window closed unobserved.
   */
  awaitingReaction?: boolean
}

/** Root state for the dwarf-messaging store, keyed by dwarf id. */
export interface DwarfMessagingState {
  byDwarfId: Record<string, DwarfSendState>
}

export function defaultDwarfMessagingState(): DwarfMessagingState {
  return { byDwarfId: {} }
}

/**
 * What the panel shows about one dwarf's most recent kick: in flight, or the
 * verdict. Same two-phase honesty as DwarfSendState — an interrupt handed to a
 * session is not the same as a session that stopped.
 */
export interface DwarfKickState {
  phase: 'kicking' | 'delivered' | 'reacted' | 'failed'
  /** The channel the kick used, once one was chosen. */
  via?: string
  /** Why it failed, shown on the marker. */
  error?: string
  /** True while a delivered kick is still watching for proof the session stopped. */
  awaitingReaction?: boolean
}

/** Root state for the dwarf-kicking store, keyed by dwarf id. */
export interface DwarfKickingState {
  byDwarfId: Record<string, DwarfKickState>
}

export function defaultDwarfKickingState(): DwarfKickingState {
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
