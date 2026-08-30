/**
 * Ports for handing a typed message to a live agent session.
 *
 * Two halves, deliberately separate:
 *
 * - `TextDeliveryTarget` is what a *provider* knows: which channel exists for
 *   one dwarf, and the identity that channel needs (a pid, a session name, or
 *   a foreman to defer to). Providers answer it from data they already read
 *   during a scan, so it stays pure and cheap.
 * - `TextDeliveryPort` is the *mechanism*: it actually writes the text. The
 *   shipped implementation is Windows-specific (window focus + synthesized
 *   keystrokes, and a one-shot `claude -p` relay), but nothing above it knows
 *   that — a future AttachConsole/WriteConsoleInput or per-OS implementation
 *   swaps in behind this interface without touching the runtime or the UI.
 */

/**
 * Where one dwarf's text should physically go, as reported by its provider.
 *
 * A 'terminal' target may also carry `sessionName`: the same relay address a
 * 'claude-relay' target uses. It is the fallback, not the channel — the
 * runtime tries the console first (keystrokes are instant; a relay turn is a
 * whole `claude -p` run) and reaches for the name only when the console
 * cannot be focused or typed into, so a failed focus no longer loses the
 * message (issue #24).
 */
export type TextDeliveryTarget =
  | { kind: 'terminal'; pid: number; sessionName?: string }
  | { kind: 'claude-relay'; sessionName: string }
  | { kind: 'foreman-relay'; foremanDwarfId: string; workerName: string }

/** A target that can actually be written to (a foreman hop has been resolved away). */
export type TextDeliveryEndpoint = Extract<
  TextDeliveryTarget,
  { kind: 'terminal' } | { kind: 'claude-relay' }
>

export interface ConsoleTextRequest {
  /** The session pid; its hosting terminal window is what receives the keystrokes. */
  pid: number
  text: string
  pressEnter: boolean
}

export interface RelayTextRequest {
  /** The addressable Claude session name, e.g. 'ai-tools-70'. */
  sessionName: string
  text: string
}

/** Kick's terminal path: no text at all, just a keystroke. */
export interface InterruptRequest {
  /** The session pid; its hosting terminal window receives the keystroke. */
  pid: number
}

/** Result of one write attempt. Never echoes the message back (privacy). */
export interface TextDeliveryOutcome {
  delivered: boolean
  error?: string
}

export interface TextDeliveryPort {
  /**
   * Whether this platform can actually type into a console at all. Undefined
   * means yes (the Windows reading, and what every test fake wants).
   *
   * Linux has no portable way to synthesize a keystroke into someone else's
   * terminal, and the macOS path is not integration-verified yet, so both
   * report false. The runtime reads this before offering a 'terminal' channel
   * to the panel: a button that cannot deliver is shown disabled with a reason
   * rather than failing after the user has typed.
   */
  readonly supportsConsoleInput?: boolean
  /** Type the text into the console hosting `pid`. */
  sendToConsole(request: ConsoleTextRequest): Promise<TextDeliveryOutcome>
  /** Hand the text to a named, window-less Claude session over its own messaging. */
  relayToClaudeSession(request: RelayTextRequest): Promise<TextDeliveryOutcome>
  /**
   * Send a raw interrupt keystroke (ESC) to the console hosting `pid` —
   * Kick's terminal path. Never routed through the message path: there is no
   * text to escape, only a keystroke to synthesize.
   */
  sendInterrupt(request: InterruptRequest): Promise<TextDeliveryOutcome>
}
