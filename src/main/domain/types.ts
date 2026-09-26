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
  DwarfAskQuestion,
  DwarfAttachment,
  DwarfAttachmentKind,
  DwarfAttachmentPick,
  DwarfAttachmentRefusal,
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
  DwarfQuestionLabelAnswer,
  DwarfQuestionTextAnswer,
  DwarfQuestionAnswerResult,
  DwarfQuestionOption,
  DwarfRole,
  DwarfSendSettledPush,
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
  OpenMineId,
  /* --- end of the #316 block ---------------------------------------------- */
  /* --- Typography preferences (#370) — one block, appended ----------------- */
  InterfaceFont,
  MessagingFont,
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
  OpenCodeSettings,
  /* --- end of the #588 T6 block ------------------------------------------------ */
  /* --- OpenCode credential check before launch (#597 T3) — one block, appended --- */
  OpenCodeCredentialMissing,
  /* --- end of the #597 T3 block -------------------------------------------------- */
  /* --- OpenCode login operations (#597 T4) — one block, appended --- */
  OpenCodeAuthMethod,
  OpenCodeAuthMethodsRequest,
  OpenCodeAuthMethodsResult,
  OpenCodeAuthPrompt,
  OpenCodeAuthPromptWhen,
  OpenCodeAuthSelectOption,
  OpenCodeAuthSelectPrompt,
  OpenCodeAuthTextPrompt,
  OpenCodeCompleteOAuthRequest,
  OpenCodeLoginFailureReason,
  OpenCodeLoginResult,
  OpenCodeOAuthStartResult,
  OpenCodeStartOAuthRequest,
  OpenCodeSubmitApiKeyRequest
  /* --- end of the #597 T4 block --- */
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
  TYPED_HERE_REACHES_THE_PICKER,
  OPENCODE_PERMISSION_ANSWERED_ABOVE,
  NO_ANSWER_KEYSTROKE_TIER,
  ANSWER_LABEL_SEPARATOR,
  NOTHING_TYPED_TO_ANSWER_WITH,
  OTHER_ROW_NOT_MEASURED_FOR_THIS_ASK,
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
  HELD_CONVERSATION_LIMIT,
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
  WINDOWS_COMMAND_LINE_LIMIT,
  clampAudioVolume,
  dwarfSilenceWindowKey,
  dwarfSilenceWindowMs,
  isDwarfProvider,
  isHeldPermissionMode,
  isMcpConnectionStatus,
  isMessagePanelDragPhase,
  isMessagePanelSurface,
  isMineTier,
  isPanelObserved,
  parseAudioPreferences,
  parseDwarfText,
  maxTextCharsFor,
  messageTooLongReason,
  stripRelayProvenance,
  /* --- System notifications (#316) — one block, appended ------------------- */
  DEFAULT_NOTIFICATIONS_ENABLED,
  /* --- end of the #316 block ---------------------------------------------- */
  /* --- Typography preferences (#370) — one block, appended ----------------- */
  DEFAULT_TYPOGRAPHY_PREFERENCES,
  INTERFACE_FONTS,
  MESSAGING_FONTS,
  isInterfaceFont,
  isMessagingFont,
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
