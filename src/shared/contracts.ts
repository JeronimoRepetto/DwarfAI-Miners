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
  /**
   * What the action menu can offer for this dwarf right now, resolved by the
   * runtime on every poll alongside textDelivery. Absent has the same meaning
   * as every field being null: no provider channel was reachable at all.
   */
  capabilities?: DwarfCapabilities
}

/**
 * Per-dwarf action capability matrix. Each member names the channel that
 * capability would use, or null when there is no way to offer it right now —
 * the action menu renders every button unconditionally and disables the ones
 * that resolve to null, with a reason, instead of hiding them.
 */
export interface DwarfCapabilities {
  /** Same channel model as textDelivery; kept here too so the matrix is self-contained. */
  sendText: TextDeliveryChannel | null
  /**
   * Cancelling reuses whichever channel sendText would use — a terminal gets a
   * raw interrupt keystroke instead of typed text, a relay tier gets a fixed
   * instruction instead of the user's message — so it is null exactly when
   * sendText is null (see resolveKickDelivery).
   */
  cancel: TextDeliveryChannel | null
  /**
   * Always null in v1: no provider exposes a channel to change a running
   * session's effort. Modeled now so a future channel plugs in without a UI change.
   */
  adjustEffort: null
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

/** One request to cancel a dwarf's current work. No user text is ever involved. */
export interface DwarfKickRequest {
  dwarfId: string
}

/** Verdict of one kick attempt. Same shape as DwarfTextResult for a consistent panel. */
export interface DwarfKickResult {
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
  sendDwarfText: 'dwarf:sendText',
  kickDwarf: 'dwarf:kick'
} as const
