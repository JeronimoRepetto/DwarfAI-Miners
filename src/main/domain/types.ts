/**
 * Domain model shared between the main process (providers, aggregator) and
 * the renderer (via the typed preload API). Pure types + defaultX() factories,
 * no Electron or Node imports.
 */

export type {
  Dwarf,
  DwarfProvider,
  DwarfRole,
  DwarfStatus,
  DwarfTextRequest,
  DwarfTextResult,
  FeedMessage,
  Mine,
  MineTier,
  ProviderSnapshot,
  SessionStatus,
  TextDeliveryChannel
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
  return { id: '', path: '', name: 'Mine', tier: 'bronze', dwarfs: [], updatedAt: 0 }
}

export function defaultProviderSnapshot(): ProviderSnapshot {
  return { provider: 'claude', sessionId: '', cwd: '', status: 'idle', dwarfs: [], updatedAt: 0 }
}

export function defaultFeedMessage(): FeedMessage {
  return { role: 'assistant', text: '', timestamp: '' }
}
