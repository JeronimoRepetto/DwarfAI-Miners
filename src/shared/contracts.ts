/**
 * Data crossing the Electron process boundary. Keep this module free from
 * Electron and Node imports so it can be shared by main, preload and renderer.
 */

export type MineTier = 'bronze' | 'copper' | 'silver' | 'gold' | 'uranium'

export type DwarfProvider = 'claude' | 'codex'

export type DwarfRole = 'foreman' | 'worker'

/**
 * working: actively producing (busy). waiting: session alive but paused/awaiting
 * (a resting dwarf). leaving: present in the previous runtime tick but its
 * agent finished/disappeared — kept for a grace period, then dropped.
 */
export type DwarfStatus = 'working' | 'waiting' | 'leaving'

export interface Dwarf {
  id: string
  provider: DwarfProvider
  role: DwarfRole
  name: string
  model?: string
  effort?: string
  status: DwarfStatus
  description?: string
  lastMessage?: string
  sessionId: string
  pid?: number
  startedAt?: number
}

export interface Mine {
  id: string
  path: string
  name: string
  tier: MineTier
  dwarfs: Dwarf[]
  updatedAt: number
}

export type SessionStatus = 'busy' | 'idle'

export interface ProviderSnapshot {
  provider: DwarfProvider
  sessionId: string
  cwd: string
  status: SessionStatus
  dwarfs: Dwarf[]
  updatedAt: number
}

export interface FeedMessage {
  role: 'user' | 'assistant'
  text: string
  timestamp: string
}

/** Result of trying to open the terminal that hosts a visualized dwarf. */
export interface DwarfActivation {
  /** True when an existing terminal window was found and brought to the foreground. */
  focused: boolean
  /** True when no window could be focused, but a new terminal was opened tailing the transcript. */
  openedTerminal: boolean
  /** Recent transcript messages, used only when both focused and openedTerminal are false. */
  feed: FeedMessage[]
}

export const IPC_CHANNELS = {
  hidePanel: 'panel:hide',
  getMines: 'mines:get',
  minesUpdated: 'mines:update',
  activateDwarf: 'dwarf:activate'
} as const
