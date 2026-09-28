import type {
  DwarfPermissionDecision,
  MaterialTotals,
  Mine,
  ProjectSummary,
  LaunchView
} from '../../shared/contracts'
import { DEFAULT_LAUNCH_VIEW } from '../../shared/contracts'

/** Renderer uses the shared IPC contract instead of maintaining a drift-prone copy. */
export type {
  AgentModelCatalog,
  AgentModelCatalogList,
  AgentModelSource,
  AgentProviderList,
  AgentProviderOption,
  AppBuild,
  FeatureFlags,
  AudioPreferences,
  /* The launch view (#635, PANEL-QUESTIONS 25). */
  LaunchView,
  ShellArea,
  Dwarf,
  DwarfActivation,
  DwarfAskQuestion,
  DwarfAttachment,
  DwarfAttachmentKind,
  DwarfAttachmentPick,
  DwarfAttachmentRefusal,
  DwarfAttendance,
  DwarfCapabilities,
  DwarfContextUsage,
  DwarfFeedPage,
  DwarfFeedPageRequest,
  DwarfFeedResult,
  DwarfKickRequest,
  DwarfKickResult,
  DwarfKickVia,
  DwarfMcpServerStatus,
  DwarfObserver,
  DwarfPermissionAnswerRequest,
  DwarfPermissionDecision,
  DwarfPermissionRequest,
  DwarfPromptChannel,
  DwarfProvider,
  DwarfQuestion,
  DwarfQuestionAnswerRequest,
  DwarfQuestionLabelAnswer,
  DwarfQuestionTextAnswer,
  DwarfQuestionAnswerResult,
  DwarfQuestionOption,
  DwarfRole,
  DwarfSendSettledPush,
  DwarfSessionTuning,
  DwarfStatus,
  DwarfTextRequest,
  DwarfTextResult,
  DwarfTuningChange,
  DwarfTuningRequest,
  DwarfTuningResult,
  /* Dwarf names (#635). */
  DwarfNameRequest,
  DwarfNameResult,
  DwarfWorkplace,
  CopyTextResult,
  ExternalLinkResult,
  FeedActivity,
  FeedActivityKind,
  FeedMessage,
  FeedPageCursor,
  CodexPermissionMode,
  HeldPermissionMode,
  HeldSessionLaunchRequest,
  HeldSessionLaunchResult,
  HostedLaunchRequest,
  HostedLaunchResult,
  LaunchFailedPush,
  LaunchFailureCause,
  Material,
  MaterialTotals,
  McpConnectionStatus,
  MessageIssuer,
  MetricsResetResult,
  Mine,
  MineDeclareResult,
  MineHistoryResult,
  MineHistorySpeaker,
  MineOpenPathRequest,
  MineOpenPathResult,
  MinesSnapshot,
  MineTier,
  MineUndeclareResult,
  MineWorktreeOf,
  ModelOption,
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
  WatchedFeedPush,
  /* --- System notifications (#316) — one block, appended ------------------- */
  OpenMineId,
  /* --- end of the #316 block ---------------------------------------------- */
  /* --- Typography preferences (#370) — one block, appended ----------------- */
  FontStyle,
  TypeFace,
  TypePresetId,
  TypeRole,
  TypeRoleFaces,
  TypographyPreferences,
  /* --- end of the #370 block ----------------------------------------------- */
  /* --- Jev launch routing: the API key setting (#509) — one block, appended - */
  JevSettings,
  JevUnavailableReason,
  /* --- end of the #509 block ------------------------------------------------ */
  /* --- Jev launch routing: routing a launch (#509) — one block, appended --- */
  JevFallbackReason,
  JevRouteLaunchRequest,
  JevRouteLaunchResult,
  /* --- end of the #509 block ------------------------------------------------ */
  /* --- Jev routing profiles: profile and defaults (#509 follow-up) — one block, appended --- */
  JevRoutingProfile,
  JevLaunchDefault,
  JevPreferences,
  /* --- end of the #509 follow-up block --------------------------------------- */
  /* --- Jev routing v2: the request and decision vocabulary (jev-routing-profiles T3) — one block, appended --- */
  ModelTier,
  JevRouteAnsweredPart,
  JevRouteNoulPart,
  JevRouteParts,
  /* --- end of the jev-routing-profiles T3 block ------------------------------ */
  /* --- Jev routing v2: the model step (#608) — one block, appended --------- */
  JevRouteModelPart,
  JevModelFallbackReason,
  /* --- end of the #608 block -------------------------------------------------- */
  /* --- Turn outcome (#510) — one block, appended ---------------------------- */
  TurnOutcome,
  TurnOutcomeKind,
  /* --- end of the #510 block ------------------------------------------------- */
  /* --- OpenCode permission relay: consent and server password (#588 T6) — one block, appended --- */
  OpenCodePasswordUnavailableReason,
  OpenCodeSettings
  /* --- end of the #588 T6 block ------------------------------------------------ */
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
  ANSWER_ONLY_WHERE_IT_RUNS,
  TYPED_HERE_REACHES_THE_PICKER,
  OPENCODE_PERMISSION_ANSWERED_ABOVE,
  ANSWER_LABEL_SEPARATOR,
  NOTHING_TYPED_TO_ANSWER_WITH,
  OTHER_ROW_NOT_MEASURED_FOR_THIS_ASK,
  OWN_WORDS_ONLY_WHEN_HELD,
  TYPED_ANSWER_ONLY_AT_A_PICKER,
  TYPED_ANSWER_WOULD_STEER_THE_PICKER,
  MAX_PICKER_NUMBERED_ROWS,
  askHasAReachableOtherRow,
  joinAnswerLabels,
  splitAnswerLabels,
  DEFAULT_AUDIO_PREFERENCES,
  DWARF_PROVIDERS,
  DWARF_SILENCE_WINDOW_MS,
  HELDABLE_PROVIDERS,
  PERMISSION_MODE_PROVIDERS,
  HELD_PERMISSION_MODES,
  CODEX_PERMISSION_MODES,
  MATERIALS,
  MATERIAL_TOKENS_PER_UNIT,
  MAP_SPAWN_SITE_COUNT,
  MAX_DWARF_TEXT_CHARS,
  MINE_HISTORY_MESSAGE_LIMIT,
  MINE_TIERS,
  PANEL_OBSERVER,
  RELAY_PROVENANCE_LINE,
  TIER_WEIGHT_THRESHOLDS_KB,
  WAITING_ON_HUMAN_REASON,
  WINDOWS_COMMAND_LINE_LIMIT,
  clampAudioVolume,
  dwarfSilenceWindowMs,
  isDwarfProvider,
  isHeldPermissionMode,
  isCodexPermissionMode,
  isMcpConnectionStatus,
  isMineTier,
  isPanelObserved,
  parseAudioPreferences,
  /* The launch view (#635, PANEL-QUESTIONS 25). */
  DEFAULT_LAUNCH_VIEW,
  SHELL_AREAS,
  parseLaunchView,
  maxTextCharsFor,
  messageTooLongReason,
  stripRelayProvenance,
  /* --- System notifications (#316) — one block, appended ------------------- */
  DEFAULT_NOTIFICATIONS_ENABLED,
  /* --- end of the #316 block ---------------------------------------------- */
  /* --- Typography preferences (#370) — one block, appended ----------------- */
  DEFAULT_TYPOGRAPHY_PREFERENCES,
  TYPE_FACES,
  TYPE_PRESET_FACES,
  TYPE_PRESET_IDS,
  TYPE_ROLES,
  TYPE_ROLE_FACES,
  isTypeFaceFor,
  isTypePresetId,
  parseTypographyPreferences,
  /* --- end of the #370 block ----------------------------------------------- */
  /* --- Message attachments (#408) — one block, appended -------------------- */
  ATTACHMENT_CHANNELS,
  ATTACHMENT_HELD_PROVIDERS,
  DWARF_IMAGE_EXTENSIONS,
  MAX_DWARF_ATTACHMENTS,
  MAX_DWARF_ATTACHMENT_BYTES,
  MAX_DWARF_ATTACHMENTS_TOTAL_BYTES,
  attachmentKindFor,
  channelCarriesAttachments,
  isDwarfAttachment,
  refuseAttachment,
  /* --- end of the #408 block ----------------------------------------------- */
  /* --- The relay's prompt on stdin (#437) — one block, appended ------------- */
  MAX_CODEX_QUEUE_TEXT_CHARS,
  /* --- end of the #437 block ----------------------------------------------- */
  /* --- Jev launch routing: the API key setting (#509) — one block, appended - */
  DEFAULT_JEV_SETTINGS,
  MAX_JEV_API_KEY_CHARS,
  parseJevApiKeyInput,
  /* --- end of the #509 block ------------------------------------------------ */
  /* --- Jev launch routing: routing a launch (#509) — one block, appended --- */
  parseJevRouteLaunchRequest,
  /* --- end of the #509 block ------------------------------------------------ */
  /* --- Jev routing profiles: profile and defaults (#509 follow-up) — one block, appended --- */
  JEV_ROUTING_PROFILES,
  DEFAULT_JEV_ROUTING_PROFILE,
  DEFAULT_JEV_PREFERENCES,
  isJevRoutingProfile,
  parseJevPreferences,
  /* --- end of the #509 follow-up block --------------------------------------- */
  /* --- Turn outcome (#510) — one block, appended ---------------------------- */
  boundTurnText,
  /* --- end of the #510 block ------------------------------------------------- */
  /* --- OpenCode permission relay: consent and server password (#588 T6) — one block, appended --- */
  DEFAULT_OPENCODE_SETTINGS,
  MAX_OPENCODE_SERVER_PASSWORD_CHARS,
  parseOpenCodeServerPasswordInput
  /* --- end of the #588 T6 block ------------------------------------------------ */
} from '../../shared/contracts'

/** Root state for the mines store. */
export interface MinesState {
  mines: Mine[]
  /**
   * Sum of every mine's tokensObserved, as main publishes it. The map's chip read it until #635;
   * the redesigned totals plate shows units per material, so no view reads it now.
   */
  tokensObserved: number
  /**
   * The whole vault by material, for the Map page's totals (see #22).
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

/*
 * MOVED to shared/contracts.ts for #162, and back for #635: DwarfSendState, DwarfKickState,
 * DwarfDeliveryReport and FailedSend crossed a process boundary while the composer and the kick
 * control lived in the message panel's own window and the markers were drawn in the shell's. That
 * window is gone (the panel is anchored in the shell's dock slot), so they are this process's own
 * state again.
 */

/**
 * What the panel shows about one dwarf's most recent message: in flight, or
 * the verdict, kept just long enough to be read.
 *
 * 'delivered' and 'reacted' are two different facts, and the panel must never
 * blur them (issue #21): delivered means the text reached the session's queue,
 * reacted means the session was then SEEN acting on it. A delivery that is
 * never observed reacting stays 'delivered' — it never promotes on a guess.
 *
 * The renderer's own again since #635 (on the wire for #162, while the send
 * happened in the message panel's own window): see the note above.
 */
export interface DwarfSendState {
  /**
   * 'held' is the one phase that claims NOTHING (#457, #534). A message the
   * panel is holding for a Codex thread or an OpenCode session whose turn is
   * still running sits in this app's own memory: no channel has been asked
   * anything, so 'sending' would say it is in flight and 'delivered' would
   * say it was handed over, and both are false. It is its own phase for
   * exactly that reason, and it is never a resting place — every held
   * message ends as 'delivered' when its continuation fires, or as 'failed'
   * when it cannot (the session was kicked, the wait ran out, or the
   * continuation itself refused).
   */
  phase: 'sending' | 'held' | 'delivered' | 'reacted' | 'failed'
  /** The channel the delivery used, once one was chosen. */
  via?: string
  /** Why it failed, shown on the marker. */
  error?: string
  /**
   * True while a delivered message is still watching its dwarf's snapshots for
   * proof the session acted. False once that bounded window closed unobserved.
   */
  awaitingReaction?: boolean
  /**
   * True on a 'delivered' state that got there because a relay courier was
   * killed by its own timeout, not because anything confirmed the hand-over
   * (#439) — carried straight from DwarfTextResult.unconfirmed. Read only
   * alongside `phase === 'delivered'`, and never on 'failed': the whole point
   * is that this is NOT the same claim as a failure, so it decays exactly like
   * an ordinary delivered message (the reaction watch may still promote it to
   * 'reacted') while the marker keeps showing its own honest sentence instead
   * of the plain "watching" or "no reaction seen" copy — see
   * renderer/lib/delivery/deliveryVerdict.ts.
   */
  unconfirmed?: boolean
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

/** A message that never reached its session: its words, and when it was sent (epoch ms). */
export interface FailedSend {
  text: string
  sentAt: number
}

/**
 * Every delivery verdict the dock holds, as the mine draws its markers from it and the history
 * its failed messages (#162, #635). Whole maps, because the stores expire their own entries on
 * timers: a marker missing from them is a marker whose time is up.
 */
export interface DwarfDeliveryReport {
  /** Send verdicts, keyed by dwarf id. */
  send: Record<string, DwarfSendState>
  /** Kick verdicts, keyed by dwarf id. */
  kick: Record<string, DwarfKickState>
  /**
   * The messages the panel sent that never reached their session, per dwarf, oldest first
   * (PANEL-QUESTIONS 16): the app's own record of the send, which the mine history draws because
   * no transcript holds them. Absent when there is none.
   */
  failed?: Record<string, FailedSend[]>
}

/**
 * What the dock's window slot is asked to hold, for the chat and the launch (#635): nothing, the
 * Add panel on a mine, or the MessagePanel on one dwarf of a mine. The two share one slot because
 * submitting a launch replaces the Add panel with the MessagePanel on its dwarf. Main held this
 * for two windows until #635 (#162); it is the renderer's own now.
 */
export type MessagePanelSurface = 'none' | 'launch' | 'message'

/**
 * The surface, with the mine it belongs to and the dwarf a chat is open on. '' rather than absent
 * where they do not apply: 'none' names neither, and 'launch' only the mine, because the dwarf
 * does not exist yet.
 */
export interface MessagePanelState {
  surface: MessagePanelSurface
  /** The mine the surface belongs to; '' when nothing is open. */
  mineId: string
  /** The dwarf a message surface is open on; '' for the other two. */
  dwarfId: string
}

/** Root state for the dwarf-messaging store, keyed by dwarf id. */
export interface DwarfMessagingState {
  byDwarfId: Record<string, DwarfSendState>
}

export function defaultDwarfMessagingState(): DwarfMessagingState {
  return { byDwarfId: {} }
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
 * Where the panel currently is: which of the six shell areas the navigation
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
 *
 * AMENDED for #635 (PANEL-QUESTIONS 25): the app opens on the view it last closed on, which main
 * stores, so this is the wire's `LaunchView` itself rather than a copy of its shape.
 */
export type ViewState = LaunchView

/** A first run's view: the Map page with no mine open (`DEFAULT_LAUNCH_VIEW`). */
export function defaultViewState(): ViewState {
  return { ...DEFAULT_LAUNCH_VIEW }
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
