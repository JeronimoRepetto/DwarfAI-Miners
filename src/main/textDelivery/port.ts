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

import type { StageTimings } from './timing'

/**
 * Where one dwarf's text should physically go, as reported by its provider.
 *
 * A 'terminal' target may also carry `sessionName`: the same relay address a
 * 'claude-relay' target uses. It is the fallback, not the channel — the
 * runtime tries the console first (keystrokes are instant; a relay turn is a
 * whole `claude -p` run) and reaches for the name only when the console
 * cannot be focused or typed into, so a failed focus no longer loses the
 * message (issue #24).
 *
 * A 'codex-queue' target has no such second address and needs none: it wants
 * neither a window nor a pid, only the thread's own UUID, which is why it is
 * the one channel a Codex session has ever had (#97).
 *
 * A 'held-session' target is the one kind no provider ever reports, because it
 * is not a fact about the session — it is a fact about THIS PROCESS: the panel
 * is holding that session's own input stream, so the message goes onto it
 * directly (#210). It carries no fallback address on purpose. The relay name a
 * held session also has is exactly the trap #210 was: an SDK-hosted session has
 * no REPL, so cross-session messaging reaches a queue nothing drains, and a
 * relay exiting 0 for it is the ✓ that cannot be true.
 *
 * A 'launched-process' target is the other kind no provider reports, and for
 * the same reason: it is a fact about this process — the panel STARTED that
 * session and still holds the process it started (#217). It is the one target
 * that can be ended and can never be written to, so it addresses a launch
 * rather than a session, a window or a pid: the pid behind it belongs to
 * LaunchedSessionRegistry, which is what knows whether that process is still
 * the one it started.
 *
 * A 'hosted-stdin' target is the third of that family and the completion of it
 * (#194): the panel started that process AND still holds its stdin, so it is
 * the one target that can be both written to and ended. It addresses a hosted
 * process rather than a session or a pid, for the reason 'launched-process'
 * addresses a launch — HostedProcessRegistry is what knows whether that pipe
 * is still open and whether that pid is still the one it started.
 */
export type TextDeliveryTarget =
  | { kind: 'terminal'; pid: number; sessionName?: string }
  | { kind: 'claude-relay'; sessionName: string }
  | { kind: 'foreman-relay'; foremanDwarfId: string; workerName: string }
  | { kind: 'codex-queue'; threadId: string }
  | { kind: 'held-session'; sessionId: string }
  | { kind: 'launched-process'; launchId: string }
  | { kind: 'hosted-stdin'; hostedId: string }

/**
 * A target that can actually be written to (a foreman hop has been resolved away).
 *
 * 'held-session' is writable but NOT through TextDeliveryPort below: this file's
 * two halves split provider knowledge from platform mechanism, and holding a
 * stream open is neither — it belongs to HeldSessionRegistry, which the runtime
 * owns. So the runtime dispatches this kind to the registry, and no per-OS
 * implementation ever grows a branch for it.
 *
 * 'hosted-stdin' is writable on exactly those terms and for exactly that reason
 * (#194): a pipe this process is holding is neither provider knowledge nor
 * platform mechanism, so it is dispatched to HostedProcessRegistry and no
 * per-OS port grows a branch for it either.
 */
export type TextDeliveryEndpoint = Extract<
  TextDeliveryTarget,
  | { kind: 'terminal' }
  | { kind: 'claude-relay' }
  | { kind: 'codex-queue' }
  | { kind: 'held-session' }
  | { kind: 'launched-process' }
  | { kind: 'hosted-stdin' }
>

/**
 * The endpoints a MESSAGE can land on — every writable one except a process
 * this panel launched (#217).
 *
 * `codex exec` reads one prompt from stdin and exits when its turn ends, so
 * there is no inbox behind a launched Codex session and no process left to
 * read one: a composer that accepted text for it would take the message and
 * lose it. The exclusion is in the type rather than in a comment so that
 * sendDwarfText cannot grow a branch for it by accident; resolveTextDelivery
 * is where it is enforced, and the panel's refusal says which launch shape it
 * is refusing rather than the generic "no channel yet".
 *
 * 'hosted-stdin' is INCLUDED, and the contrast is the point (#194): the same
 * app started that process too, and the difference is only that it kept the
 * pipe instead of closing it. So the exclusion above is about a closed stdin
 * rather than about "a process we launched" — which is why hosting is worth
 * its lifetime cost at all.
 */
export type SendEndpoint = Exclude<TextDeliveryEndpoint, { kind: 'launched-process' }>

/**
 * The endpoints a KICK can land on — every writable one except the Codex queue.
 *
 * 'held-session' is the strongest of them: the panel holds the session's own
 * stream, so a kick there is a real interrupt of the running turn rather than an
 * instruction the session may decline (#210).
 *
 * A queued item is drained at the thread's next idle boundary, so an interrupt
 * sent that way would arrive precisely when the turn it meant to cut short had
 * already ended: `delivered: true`, a ✓, and nothing cancelled. Mid-turn drain
 * is the one thing the live experiment did not test, and a cancel channel built
 * on the untested half would be the exit-0-shaped lie (#97). The exclusion is
 * in the type rather than in a comment so kickDwarf cannot grow a queue branch
 * by accident; resolveKickDelivery is where it is enforced.
 *
 * 'launched-process' is the harshest of them and the only one that is not an
 * interrupt at all: it ENDS the session rather than the turn (#217). Kick's
 * meaning is "stop what you are doing" everywhere else, so this one is only
 * ever offered where nothing weaker exists, and the panel has to say which act
 * it performed — a person told a turn was interrupted, when the session is
 * gone, has been told the wrong thing.
 *
 * 'hosted-stdin' is harsh in the same way and has to say so in the same words
 * (#194). This app knows nothing about what the person's program treats as an
 * interrupt — a byte it happens to accept as one would be this panel guessing
 * at another program's key bindings — so the only act available is the tree
 * kill, and the only honest thing to call it is ending the session.
 */
export type KickEndpoint = Exclude<TextDeliveryEndpoint, { kind: 'codex-queue' }>

export interface ConsoleTextRequest {
  /** The session pid; its hosting terminal window is what receives the keystrokes. */
  pid: number
  text: string
  pressEnter: boolean
}

export interface RelayTextRequest {
  /** The addressable Claude session name, e.g. 'sample-project-70'. */
  sessionName: string
  text: string
}

export interface CodexQueueRequest {
  /** The Codex thread's own UUID, which is what `codex queue --thread` takes. */
  threadId: string
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
  /**
   * How long this tier's own stages took, when it measured them (issue #21).
   * Durations only — there is no way for a payload to travel in here. The
   * runtime folds these into the one log line it writes per attempt, and adds
   * the stages only it can see (the total, and the relay call it makes itself).
   */
  stages?: StageTimings
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
   * Hand the text to a Codex thread's own message queue, addressed by thread id
   * (#97).
   *
   * Optional for the reason supportsConsoleInput and dispose are: a port that
   * implements nothing here simply has no queue tier, and the runtime turns
   * that into a stated refusal rather than a silent no-op. Both shipped ports
   * implement it — it spawns a CLI, so it is platform-neutral like the relay.
   */
  queueToCodexThread?(request: CodexQueueRequest): Promise<TextDeliveryOutcome>
  /**
   * Send a raw interrupt keystroke (ESC) to the console hosting `pid` —
   * Kick's terminal path. Never routed through the message path: there is no
   * text to escape, only a keystroke to synthesize.
   */
  sendInterrupt(request: InterruptRequest): Promise<TextDeliveryOutcome>
  /**
   * Release anything this tier keeps alive between actions — today, the
   * long-lived console shell (see consoleWorker.ts). Optional because most
   * implementations hold nothing; the runtime calls it on stop() so a quit
   * never leaves a stray process behind.
   */
  dispose?(): void
}
