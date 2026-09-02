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
  Dwarf,
  DwarfActivation,
  DwarfAttendance,
  DwarfCapabilities,
  DwarfKickRequest,
  DwarfKickResult,
  DwarfProvider,
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
  DWARF_SILENCE_WINDOW_MS,
  MATERIALS,
  MATERIAL_TOKENS_PER_UNIT,
  MAX_DWARF_TEXT_CHARS,
  WAITING_ON_HUMAN_REASON,
  dwarfSilenceWindowKey
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
