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
  Dwarf,
  DwarfActivation,
  DwarfAttendance,
  DwarfCapabilities,
  DwarfKickRequest,
  DwarfKickResult,
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
  Material,
  MaterialTotals,
  MetricsResetResult,
  Mine,
  MineDeclareResult,
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
  ProviderSnapshot,
  SessionStatus,
  ShortcutState,
  TextDeliveryChannel,
  WaitingReason
} from '../../shared/contracts'

/**
 * The wire constants and helpers the process reads as VALUES, re-exported for
 * the same reason the renderer barrel re-exports its own: a value left off the
 * barrel is what makes a module reach across the process boundary itself.
 */
export {
  DWARF_PROVIDERS,
  DWARF_SILENCE_WINDOW_MS,
  MATERIALS,
  MATERIAL_TOKENS_PER_UNIT,
  MAP_SPAWN_SITE_COUNT,
  MAX_DWARF_TEXT_CHARS,
  MINE_TIERS,
  TIER_WEIGHT_THRESHOLDS_KB,
  WAITING_ON_HUMAN_REASON,
  dwarfSilenceWindowKey,
  isDwarfProvider,
  isMineTier
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
