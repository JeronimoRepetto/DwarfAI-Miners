import type {
  DwarfPermissionDecision,
  MaterialTotals,
  Mine,
  ProjectSummary
} from '../../shared/contracts'
import type { ShellArea } from './lib/shell/shellNav'

/** The five areas the shell's navigation stack selects (#90). */
export type { ShellArea }

/** Renderer uses the shared IPC contract instead of maintaining a drift-prone copy. */
export type {
  AgentProviderList,
  AgentProviderOption,
  AppBuild,
  Dwarf,
  DwarfActivation,
  DwarfAttendance,
  DwarfCapabilities,
  DwarfFeedResult,
  DwarfKickRequest,
  DwarfKickResult,
  DwarfMcpServerStatus,
  DwarfObserver,
  DwarfPermissionAnswerRequest,
  DwarfPermissionChannel,
  DwarfPermissionDecision,
  DwarfPermissionRequest,
  DwarfProvider,
  DwarfQuestion,
  DwarfQuestionAnswerRequest,
  DwarfQuestionAnswerResult,
  DwarfQuestionOption,
  DwarfRole,
  DwarfStatus,
  DwarfTextRequest,
  DwarfTextResult,
  FeedMessage,
  HeldSessionLaunchRequest,
  HeldSessionLaunchResult,
  HostedLaunchRequest,
  HostedLaunchResult,
  Material,
  MaterialTotals,
  McpConnectionStatus,
  MessageIssuer,
  MetricsResetResult,
  Mine,
  MineDeclareResult,
  MineHistoryResult,
  MineHistorySpeaker,
  MinesSnapshot,
  MineTier,
  MineUndeclareResult,
  PanelEdge,
  PanelLayout,
  PanelLayoutRequest,
  ProjectQuery,
  ProjectQueryResult,
  ProjectSortDirection,
  ProjectSortKey,
  ProjectSummary,
  ShortcutState,
  TextDeliveryChannel,
  WaitingReason,
  WatchedFeedPush
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
  DWARF_PROVIDERS,
  DWARF_SILENCE_WINDOW_MS,
  HELDABLE_PROVIDERS,
  MATERIALS,
  MATERIAL_TOKENS_PER_UNIT,
  MAP_SPAWN_SITE_COUNT,
  MAX_DWARF_TEXT_CHARS,
  MINE_HISTORY_MESSAGE_LIMIT,
  MINE_TIERS,
  PANEL_OBSERVER,
  TIER_WEIGHT_THRESHOLDS_KB,
  WAITING_ON_HUMAN_REASON,
  dwarfSilenceWindowMs,
  isDwarfProvider,
  isMcpConnectionStatus,
  isMineTier,
  isPanelObserved
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
  /**
   * The dwarfs on this snapshot that were not on the one before it (#156).
   *
   * Renderer-only, and deliberately not on the wire: it is a statement about
   * two consecutive things the PANEL saw, and main publishes each snapshot
   * without knowing which of them any given panel has already been shown.
   *
   * The mine's interior walks an arriving dwarf in from a spawn point and used
   * to work out who had arrived from its own first snapshot — which cannot see
   * the case the acceptance run found. A mine nobody is working is not on the
   * board at all, so its interior is not mounted; launch the first agent and
   * the scene mounts with that agent already in it, and reads it as crew that
   * was at work before anybody looked. The panel has been polling all along and
   * does know, so it says.
   *
   * Empty on the first snapshot after a clear: everything already running when
   * the panel started was already running, and calling that an arrival would
   * parade the whole valley across its interiors.
   */
  arrived: ReadonlySet<string>
}

export function defaultMinesState(): MinesState {
  return { mines: [], tokensObserved: 0, arrived: new Set() }
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

/**
 * What the panel shows about one answer to an agent's question (issue #125).
 *
 * Deliberately NOT the two-phase shape DwarfSendState and DwarfKickState carry.
 * Those infer a reaction from later snapshots because a relay can offer no
 * better evidence; a held session can. 'answered' means main released the
 * agent's own blocked tool call with this choice — the causal event itself, not
 * a guess about behaviour after the fact — so there is nothing left to watch
 * for and no weaker second phase to promote to. It stays as narrow as
 * `delivered` in what it claims: the agent was handed the choice, never what it
 * then did with it.
 *
 * `toolUseId` is what the verdict is ABOUT. A verdict outlives nothing: the ask
 * it names is the only one it may be shown against, so a new question never
 * inherits the last one's answer.
 */
export interface DwarfAnswerState {
  phase: 'answering' | 'answered' | 'refused'
  /** The ask this verdict belongs to. */
  toolUseId: string
  /** Why main refused it, shown in the panel. */
  error?: string
  /**
   * Which decision this verdict was given for, on a permission prompt (#203).
   * Absent for an answered QUESTION, which has no such vocabulary.
   *
   * Here because what the panel may claim afterwards depends on it, and only
   * on a terminal channel: an Allow typed there is a keypress waiting to be
   * acted on, and a Deny is an Esc whose second meaning — interrupting a turn
   * somebody already allowed — the person has to be told about. The verdict
   * is where it belongs rather than on the card's own selection, which is
   * state a re-render is free to lose.
   */
  decision?: DwarfPermissionDecision
}

/** Root state for the dwarf-question store, keyed by dwarf id. */
export interface DwarfQuestionState {
  byDwarfId: Record<string, DwarfAnswerState>
}

export function defaultDwarfQuestionState(): DwarfQuestionState {
  return { byDwarfId: {} }
}

/**
 * Where the panel currently is: which of the five shell areas the navigation
 * stack has selected, and which mine — if any — is held open beside it.
 *
 * The two are concurrent rather than exclusive (#90). That is the design's
 * model, not a convenience: an opened mine stays visible while a secondary panel
 * is inspected, and the verified exports prove exactly one mine beside exactly
 * one secondary panel. It replaces a `View` union in which walking into a mine
 * REPLACED the map, so coming back out meant losing where you were.
 *
 * `area` never becomes a mine, and `mineId` is never an area: a mine belongs to
 * the board and can vanish under the panel, while the areas are fixed furniture
 * — 'mines' in particular carries no state of its own, because its filters and
 * pages belong to useProjectBrowse.
 */
export interface ViewState {
  area: ShellArea
  /** The mine held open beside the secondary panel, or null when none is. */
  mineId: string | null
}

export function defaultViewState(): ViewState {
  return { area: 'map', mineId: null }
}

/**
 * One row of the Mines list (#165).
 *
 * The list used to be store rows and the map used to be the board, so a mine
 * could stand on the map with no card beside it. They are one world now, and
 * this is the row shape that carries the join: a card the store answered with,
 * or one the panel built from a board mine main said the store has no row for.
 *
 * Renderer-local rather than a wire type, and deliberately so: the whole point
 * is that an unrecorded row is NOT a project summary main sent — the fields it
 * cannot back are absent, and `unrecorded` is what tells the card to say so.
 * The board's own `Mine.unrecorded` is the wire half of the same fact.
 */
export interface BrowseRow extends ProjectSummary {
  /** True when this row was built from the board because the store had none. */
  unrecorded?: boolean
}
