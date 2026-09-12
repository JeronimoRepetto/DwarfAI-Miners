/**
 * Domain model shared between the main process (providers, aggregator) and
 * the renderer (via the typed preload API). Pure re-exports + defaultX()
 * factories, no Electron or Node imports.
 *
 * This is the main process's one door onto `shared/contracts.ts`, so it has to
 * carry everything the process asks for — a symbol missing here does not send
 * one import past the barrel, it sends the whole statement, and the file then
 * reads two roots for shapes that came from the same place (#77). Only
 * `index.ts` reads the contract directly, because it is the IPC endpoint.
 */

export type {
  AgentLaunchRequest,
  AgentLaunchResult,
  AgentModelCatalog,
  AgentModelCatalogList,
  AgentModelSource,
  AgentProviderList,
  AgentProviderOption,
  AudioPreferences,
  Dwarf,
  DwarfActivation,
  DwarfAttendance,
  DwarfCapabilities,
  DwarfContextUsage,
  DwarfDeliveryReport,
  DwarfFeedPage,
  DwarfFeedPageRequest,
  DwarfFeedResult,
  DwarfKickRequest,
  DwarfKickResult,
  DwarfKickState,
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
  DwarfQuestionAnswerResult,
  DwarfQuestionOption,
  DwarfRole,
  DwarfSendState,
  DwarfSessionTuning,
  DwarfStatus,
  DwarfTextRequest,
  DwarfTextResult,
  DwarfTuningChange,
  DwarfTuningRequest,
  DwarfTuningResult,
  DwarfWorkplace,
  ExternalLinkResult,
  FeedActivity,
  FeedActivityKind,
  FeedMessage,
  FeedPageCursor,
  HeldPermissionMode,
  HeldSessionLaunchRequest,
  HeldSessionLaunchResult,
  HostedLaunchRequest,
  HostedLaunchResult,
  LaunchFailedPush,
  Material,
  MaterialTotals,
  McpConnectionStatus,
  MessageIssuer,
  MessagePanelDragPhase,
  MessagePanelState,
  MessagePanelSurface,
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
  RendererSurface,
  ProjectQueryResult,
  ProjectSortDirection,
  ProjectSortKey,
  ProjectSummary,
  ProviderSnapshot,
  SessionStatus,
  ShortcutState,
  TextDeliveryChannel,
  WaitingReason,
  WatchedFeedPush,
  /* --- System notifications (#316) — one block, appended ------------------- */
  OpenMineId
  /* --- end of the #316 block ---------------------------------------------- */
} from '../../shared/contracts'

/**
 * The wire constants and helpers the process reads as VALUES, re-exported for
 * the same reason the renderer barrel re-exports its own: a value left off the
 * barrel is what makes a module reach across the process boundary itself.
 */
export {
  ANSWER_NEEDS_ITS_CONSOLE,
  ANSWER_NOT_A_CHOICE_THIS_ASK_TAKES,
  ANSWER_ONLY_WHERE_IT_RUNS,
  ANSWER_OPTION_NOT_OFFERED,
  ASK_NO_LONGER_OPEN,
  NO_ANSWER_KEYSTROKE_TIER,
  ANSWER_LABEL_SEPARATOR,
  joinAnswerLabels,
  splitAnswerLabels,
  DEFAULT_AUDIO_PREFERENCES,
  DWARF_PROVIDERS,
  DWARF_SILENCE_WINDOW_MS,
  HELDABLE_PROVIDERS,
  PERMISSION_MODE_PROVIDERS,
  HELD_CONVERSATION_LIMIT,
  HELD_MESSAGE_MAX_CHARS,
  HELD_PERMISSION_MODES,
  MATERIALS,
  MATERIAL_TOKENS_PER_UNIT,
  MESSAGE_PANEL_SURFACE,
  MAP_SPAWN_SITE_COUNT,
  MAX_DWARF_TEXT_CHARS,
  MINE_HISTORY_MESSAGE_LIMIT,
  MINE_TIERS,
  PANEL_OBSERVER,
  RELAY_PROVENANCE_LINE,
  RENDERER_SURFACE_PARAM,
  TIER_WEIGHT_THRESHOLDS_KB,
  WAITING_ON_HUMAN_REASON,
  clampAudioVolume,
  dwarfSilenceWindowKey,
  isDwarfProvider,
  isHeldPermissionMode,
  isMcpConnectionStatus,
  isMessagePanelDragPhase,
  isMessagePanelSurface,
  isMineTier,
  isPanelObserved,
  parseAudioPreferences,
  stripRelayProvenance,
  /* --- System notifications (#316) — one block, appended ------------------- */
  DEFAULT_NOTIFICATIONS_ENABLED
  /* --- end of the #316 block ---------------------------------------------- */
} from '../../shared/contracts'

import type { Dwarf, FeedMessage, Mine, ProviderSnapshot } from '../../shared/contracts'

export function defaultDwarf(): Dwarf {
  return {
    id: '',
    provider: 'claude',
    role: 'worker',
    name: 'Dwarf',
    status: 'waiting',
    sessionId: ''
  }
}

export function defaultMine(): Mine {
  return {
    id: '',
    path: '',
    name: 'Mine',
    tier: 'bronze',
    dwarfs: [],
    tokensObserved: 0,
    updatedAt: 0
  }
}

export function defaultProviderSnapshot(): ProviderSnapshot {
  return { provider: 'claude', sessionId: '', cwd: '', status: 'idle', dwarfs: [], updatedAt: 0 }
}

export function defaultFeedMessage(): FeedMessage {
  return { role: 'assistant', text: '', timestamp: '' }
}
