/**
 * Domain model shared between the main process (providers, aggregator) and
 * the renderer (via the typed preload API). Pure types + defaultX() factories,
 * no Electron or Node imports.
 */

/** Mine size class derived from the project's source-file count. */
export type MineTier = 'bronze' | 'copper' | 'silver' | 'gold' | 'uranium'

/** Which AI CLI a dwarf belongs to. */
export type DwarfProvider = 'claude' | 'codex'

/**
 * foreman = a main CLI session that currently has in-flight subagents;
 * worker = a busy session without subagents, or one in-flight subagent.
 */
export type DwarfRole = 'foreman' | 'worker'

/** Whether the dwarf is actively producing output right now. */
export type DwarfStatus = 'working' | 'idle'

/** One AI agent (main session or in-flight subagent) visualized as a dwarf. */
export interface Dwarf {
  id: string
  provider: DwarfProvider
  role: DwarfRole
  name: string
  model?: string
  effort?: string
  status: DwarfStatus
  description?: string
  /** Latest assistant text, raw and untruncated (truncation is a UI concern). */
  lastMessage?: string
  sessionId: string
  pid?: number
  /** Unix ms timestamp when the session started, if known. */
  startedAt?: number
}

export function defaultDwarf(): Dwarf {
  return { id: '', provider: 'claude', role: 'worker', name: 'Dwarf', status: 'idle', sessionId: '' }
}

/** One project directory with at least one live AI CLI session in it. */
export interface Mine {
  id: string
  /** Real absolute project path (from the session data, not the encoded dir). */
  path: string
  name: string
  tier: MineTier
  /** Empty while the session is open but nobody is working. */
  dwarfs: Dwarf[]
  /** Unix ms timestamp of the last observed activity in this mine. */
  updatedAt: number
}

export function defaultMine(): Mine {
  return { id: '', path: '', name: 'Mine', tier: 'bronze', dwarfs: [], updatedAt: 0 }
}

/** Session-level busy/idle state as reported by the provider. */
export type SessionStatus = 'busy' | 'idle'

/** One live CLI session as observed by a provider scan. */
export interface ProviderSnapshot {
  provider: DwarfProvider
  sessionId: string
  cwd: string
  status: SessionStatus
  /** Already mapped to dwarfs (foreman/workers); empty for an idle session. */
  dwarfs: Dwarf[]
  /** Unix ms timestamp of the last observed activity for this session. */
  updatedAt: number
}

export function defaultProviderSnapshot(): ProviderSnapshot {
  return { provider: 'claude', sessionId: '', cwd: '', status: 'idle', dwarfs: [], updatedAt: 0 }
}

/** One parsed transcript message, used for the renderer live feed fallback. */
export interface FeedMessage {
  role: 'user' | 'assistant'
  text: string
  /** ISO timestamp when the message was recorded (empty when unknown). */
  timestamp: string
}

export function defaultFeedMessage(): FeedMessage {
  return { role: 'assistant', text: '', timestamp: '' }
}
