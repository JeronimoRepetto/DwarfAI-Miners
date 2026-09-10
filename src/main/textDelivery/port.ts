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
 * 'claude-relay' target uses. Which of the two a given ACT reaches for is not
 * a property of the target — send and kick answer it differently, and
 * resolve.ts owns both answers (`sendRouteOf`, `kickEndpointOf`). A message
 * pastes at the console and falls back to the name; a kick ENDS the session at
 * that pid and falls back to the name (#329, #319, over #308, over #24).
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
  | {
      kind: 'held-session'
      sessionId: string
      /**
       * Whether this session's own protocol documents a way to cut the
       * running turn short (#237, step 5).
       *
       * Carried rather than derived from the KIND, because two providers can
       * be held and their protocols disagree: the Agent SDK documents an
       * `interrupt` control request, and the Antigravity CLI's bidirectional
       * stream documents user text events on its input side and nothing else.
       * A held session is still the strongest SEND channel there is either
       * way — the difference is only about the kick.
       *
       * `HeldSessionHandle` is where the fact actually lives (the capability
       * is absent from the handle rather than a method returning false), and
       * `HeldSessionRegistry.canInterrupt` is what reads it. This field is
       * that answer travelling to the one rule both the panel's capability
       * matrix and the runtime's own kick routing read — see `kickEndpointOf`
       * in resolve.ts on why there must be exactly one.
       */
      interruptible: boolean
    }
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
 * 'terminal' ENDS the session since #329, and no longer interrupts the turn.
 * Kick meant "press Esc at that console" from #24 until then, and what the
 * report showed is that a console is not addressable: several sessions share
 * one terminal window, only one of its tabs is in front, and the Esc reached
 * whichever session that was. Ending the pid the provider named needs no window
 * and cannot reach a session nobody pointed at — and a person pressing Kick on
 * a dwarf is asking for that dwarf to stop, which the harsher act delivers
 * where the keystroke had stopped delivering it at all.
 *
 * 'held-session' is the strongest of them: the panel holds the session's own
 * stream, so a kick there is a real interrupt of the running turn rather than an
 * instruction the session may decline (#210) — for a session whose protocol has
 * one at all, which since #237 step 5 is a question the endpoint answers with
 * `interruptible` rather than something its kind settles.
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

/**
 * Reading and writing the system clipboard, behind a port (#319).
 *
 * The paste path (`pasteToConsole`) puts a message on the clipboard, sends
 * Ctrl+V, and restores whatever was there before. Electron's `clipboard`
 * module is what backs it in the app, but it is injected through this seam so
 * the Windows delivery stays unit-testable with a fake and holds no Electron
 * import — exactly like `focus` and `runPowerShell`.
 *
 * Each call may be synchronous OR return a promise, and `pasteToConsole` awaits
 * either. The installed Electron's `clipboard` is promise-based —
 * `readText(): Promise<string>`, `writeText(): Promise<void>`, "modeled after
 * the W3C navigator.clipboard API" — despite older docs showing a synchronous
 * one; the union keeps a plain in-memory fake sync while the real port awaits
 * the promise.
 */
export interface ClipboardPort {
  /** The clipboard's current plain text, '' when it holds none. */
  read(): string | Promise<string>
  /** Replace the clipboard's plain text. */
  write(text: string): void | Promise<void>
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

/** A raw interrupt keystroke: no text at all, just the key. */
export interface InterruptRequest {
  /** The session pid; its hosting terminal window receives the keystroke. */
  pid: number
}

/**
 * Kick's terminal path since #329: end the session at this pid, no window
 * involved.
 *
 * A pid rather than a window, and that is the whole repair. A keystroke lands
 * in whatever holds the foreground, and a session in a terminal TAB cannot be
 * foregrounded on its own — so an Esc aimed at one session reached another one
 * (see SHARED_TERMINAL_WINDOW in windowsTextDelivery.ts). Ending a process
 * needs no window and cannot miss.
 */
export interface EndSessionRequest {
  /**
   * The session's OWN CLI pid, never an ancestor's.
   *
   * The tree below it is the session's own tool processes; the tree above it is
   * the shell, the terminal host and every other tab in that window. Ending an
   * ancestor would end all of them, which is precisely the blast radius #329
   * exists to stop. The runtime passes the pid the provider reported for this
   * dwarf and nothing derived from it — there is no ancestor walk on this path.
   */
  pid: number
  /**
   * When that pid's process was created, epoch ms, as the provider verified it
   * (`Dwarf.pidStartedAt`).
   *
   * REQUIRED, and the only optional-looking thing about it is that a caller
   * with no such value must not call at all. A pid is a number the OS recycles;
   * signalling a remembered one is how an unrelated process gets killed (#231).
   * The provider's verification happened at the last poll, which can be seconds
   * old, so the implementation re-probes the pid and compares it against this
   * value at the moment of the act — the same re-verification
   * LaunchedSessionRegistry does before its own kill.
   */
  expectedStartMs: number
}

/** Result of one write attempt. Never echoes the message back (privacy). */
export interface TextDeliveryOutcome {
  delivered: boolean
  error?: string
  /**
   * Whether this attempt never reached its channel at all — the tier could not
   * be STARTED, so nothing was handed over anywhere (#308).
   *
   * The one thing that licenses a second tier to send the SAME text, and it
   * reads the same in both directions the tiers can run (#308, #319). A failed
   * verdict is not enough on its own: a relay turn that ran and then exited
   * non-zero, or was killed by the timeout, may already have called
   * SendMessage before it died; and a console paste whose Ctrl+V ran may
   * already have landed even if the command then reported failure. A second
   * delivery behind either would put the person's message into the session
   * twice. So the flag says "provably nothing was delivered" — a relay whose
   * binary would not spawn, a paste whose window would not come forward so no
   * key was ever sent — rather than "this did not report success", and absence
   * of it means the caller must assume a possible hand-over and stop.
   *
   * Optional and false-by-absence for the reason `stages` is: a tier that
   * cannot tell the two apart simply never sets it, and the caller then treats
   * every failure as possibly-delivered — the safe direction.
   */
  neverStarted?: boolean
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
  /**
   * Type the text into the console hosting `pid`, character by character.
   *
   * Since #319 a MESSAGE goes through `pasteToConsole` instead; what still
   * types here is the permission digit of #203 — a measured keystroke that
   * fires the CLI's selector, where a paste (bracketed or not) is unverified
   * against a live dialog and must not silently replace the tested key.
   */
  sendToConsole(request: ConsoleTextRequest): Promise<TextDeliveryOutcome>
  /**
   * Paste the text into the console hosting `pid`: put it on the clipboard,
   * focus the window, send Ctrl+V (and Enter unless `pressEnter` is false),
   * then restore the previous clipboard (#319). A long message then lands at
   * once rather than over seconds of typing into the foregrounded window.
   *
   * Optional for the reason `queueToCodexThread` is: a port that cannot paste
   * simply omits it, and the runtime turns that into a `neverStarted` failure
   * so the message falls back to the relay. Only the Windows port implements
   * it — macOS/Linux keep the relay for a message (a per-OS paste is a separate
   * follow-up, see platform-ports), and where console input is unsupported a
   * named terminal target degrades to the relay before it ever reaches here.
   *
   * On a focus failure it sets `neverStarted`: nothing was pasted, so the relay
   * behind it may take the same text without risking a double delivery. Any
   * other failure leaves it unset — Ctrl+V may already have landed — exactly as
   * a relay that ran and failed does not fall back to the console.
   */
  pasteToConsole?(request: ConsoleTextRequest): Promise<TextDeliveryOutcome>
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
   * Send a raw interrupt keystroke (ESC) to the console hosting `pid`. Never
   * routed through the message path: there is no text to escape, only a
   * keystroke to synthesize.
   *
   * Kick's terminal path until #329, and no longer — a kick ends the session
   * through `endConsoleSession` below. What still presses Esc here is the
   * permission DENY of #203, which is a key aimed at the dialog that terminal
   * is drawing rather than an act on the session.
   */
  sendInterrupt(request: InterruptRequest): Promise<TextDeliveryOutcome>
  /**
   * End the session running in the console at `pid` — the whole process tree,
   * not the turn it is in (#329).
   *
   * Kick's terminal tier, and the third one that ends rather than interrupts
   * (see KickEndpoint). Since #358 an implementation SHOULD ask the session's
   * CLI to exit cleanly first — so it restores the terminal it left reporting
   * every mouse move as an escape sequence — and force-kill only if the process
   * survives a bounded grace. That clean exit is a keystroke, so it is safe only
   * on a console this session is provably alone on (never a shared terminal
   * window, #329) and only for a pid re-verified as below; otherwise it is
   * skipped and the forced kill, which needs no window and cannot miss, is all
   * there is. Either way the terminal tab stays open at its shell prompt.
   *
   * An implementation MUST re-verify `pid` against `expectedStartMs` at the
   * moment of the kill AND before any clean-exit keystroke, and refuse on
   * anything short of agreement, unknown included (#231). This is the one guard
   * in the app that fails closed.
   *
   * BOTH shipped ports implement it since #366, and the POSIX one is the
   * simpler of the two. Windows had to imitate a clean exit with keystrokes;
   * SIGTERM is catchable, so on macOS and Linux the signal itself gives the CLI
   * its own exit path — no window, no keystroke, and none of the shared-tab
   * ambiguity #329 had to design around. The signal is addressed to the pid
   * DIRECTLY there: the POSIX tree kill signals the process GROUP, which is
   * correct for a process this panel STARTED as a group leader (#217) and wrong
   * for a session somebody else launched, whose pid leads no group of ours (see
   * processEnd.ts for the two builders).
   *
   * Optional still, for the reason `pasteToConsole` is: a port without one is a
   * port that cannot end a session, and the runtime states that refusal rather
   * than pretending (see NO_TERMINAL_END_TIER). Console input is NOT what gates
   * it — that was the conflation #366 undid. A message needs the window server
   * and an end needs a pid, so a port may have either without the other, and
   * `supportsConsoleInput` says nothing about this method.
   *
   * What is unmeasured on POSIX is the guard's INPUT, not the act:
   * `expectedStartMs` comes from `Dwarf.pidStartedAt`, which the Claude provider
   * sets only where the session registry's `procStart` — documented as a Windows
   * FILETIME — agreed with a live probe. Nobody has yet measured what
   * `~/.claude/sessions/<pid>.json` records on macOS or Linux, so if it carries
   * no comparable value the verdict is 'unknown', the field is absent, and the
   * runtime refuses the kick before this method is ever called. That is the
   * correct failure — fail closed — and it means this tier stays unreachable
   * there until the measurement is taken (see docs/console-hosting.md, and do
   * not weaken the guard to reach it).
   */
  endConsoleSession?(request: EndSessionRequest): Promise<TextDeliveryOutcome>
  /**
   * Release anything this tier keeps alive between actions — today, the
   * long-lived console shell (see consoleWorker.ts). Optional because most
   * implementations hold nothing; the runtime calls it on stop() so a quit
   * never leaves a stray process behind.
   */
  dispose?(): void
}
