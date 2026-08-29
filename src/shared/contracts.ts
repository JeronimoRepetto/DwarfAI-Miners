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

/**
 * How a live session can be handed a typed message.
 *
 * terminal: the session owns a console window — keystrokes are injected into it.
 * claude-relay: the session is headless but addressable by name, so a one-shot
 *   `claude -p` turn delivers the text over Claude Code's cross-session messaging.
 * foreman-relay: the dwarf is a subagent with no channel of its own; the text
 *   goes to its foreman (parent session) under an explicit `[for agent X] ` prefix.
 *
 * A dwarf with no channel at all simply carries no value.
 */
export type TextDeliveryChannel = 'terminal' | 'claude-relay' | 'foreman-relay'

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
  /**
   * Cumulative tokens the session has spent, when the provider knows it.
   * Codex records it on its registry row; Claude does not expose an equivalent.
   */
  tokensUsed?: number
  /**
   * The channel a typed message would travel through right now, resolved by
   * the runtime on every poll. Absent means the panel must offer no send
   * action for this dwarf (see TextDeliveryChannel).
   */
  textDelivery?: TextDeliveryChannel
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

/**
 * Longest message accepted for delivery. Long enough for a real instruction,
 * short enough that keystroke injection stays a few seconds rather than a
 * minute of the user's keyboard being taken over.
 */
export const MAX_DWARF_TEXT_CHARS = 4000

/** One message the panel wants handed to a dwarf's live session. */
export interface DwarfTextRequest {
  dwarfId: string
  text: string
  /** Whether the session should also receive an ENTER, submitting the line. */
  pressEnter: boolean
}

/** Verdict of one delivery attempt. Never carries the message itself. */
export interface DwarfTextResult {
  delivered: boolean
  /** The channel used, or 'none' when no attempt was possible. */
  via: TextDeliveryChannel | 'none'
  /** Human-readable reason shown in the panel when delivered is false. */
  error?: string
}

export const IPC_CHANNELS = {
  hidePanel: 'panel:hide',
  getMines: 'mines:get',
  minesUpdated: 'mines:update',
  activateDwarf: 'dwarf:activate',
  sendDwarfText: 'dwarf:sendText'
} as const
