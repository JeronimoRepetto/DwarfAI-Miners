// The observed-session TEXT relay (15 §3.1 C4/C5 `sendTurn` "terminal relay", §3.3 limits; ADR-012
// item 3's "target checked just before writing", which the key relay beside it shares): types a
// person's message — its relay text (consoleText.ts `relayTextOf`, spike S-022-1) — into the terminal
// of a session the person started themselves, and only there, then submits it.
//
// The target is the session's process identity as observation recorded it (pid + start time + boot,
// ADR-014 item 1), never a bare pid. The terminal is resolved first (reads only, and on tmux the text
// loaded into a named buffer, which writes into no terminal), then the identity is probed AGAIN
// immediately before each write into the terminal: a process that is gone, recycled or of an earlier
// boot is `gone`; one whose start time cannot be read is `not-targeted` (06 INV-51; `unknown` is a
// mismatch). On tmux the identity is probed once more before the Enter: a pane whose process went
// away after the paste may now run a shell, and Enter there would run the person's words as a
// command, so the text is left unsubmitted (`incomplete`) instead.
//
// Per OS (builders in consoleText.ts, candidate decisions in its header):
// - Windows: a hidden PowerShell child attaches to the session's console by pid and writes the text
//   into its input buffer, the text only as base64 on the child's stdin, Enter in a call of its own.
// - macOS and Linux: the tmux pane on the session's tty (load-buffer from stdin, bracketed paste, Enter
//   alone); on macOS, outside tmux, the Terminal.app tab of that tty (`do script`, text as an osascript
//   argument, as legacy measured it). Anything else cannot be positively targeted: nothing is typed and
//   nothing is synthesized into a foreground window.
//
// Files (#1463): each Host-revalidated path is a bracketed paste ahead of the relay text
// (consoleText.ts `relayPayloadOf`, legacy #408): on Windows each paste in a write of its own, on
// tmux and Terminal.app the pastes and the words as one payload; a path no terminal can take whole
// means nothing is written (`not-targeted`).
//
// Outcomes: `written`; `not-targeted` (nothing was written: no relay text, no terminal found, the
// identity unreadable, the attach or `CONIN$` refused, a tool that would not start); `gone` (the
// session's process is not the recorded one any more, nothing written); `incomplete` (a write began
// and did not finish cleanly: part of the text, or the text without its Enter, may be in the
// terminal). Nothing here logs the text, a tty or a path.
import type { ProcessIdentity } from '../../../../kernel/domain/processIdentity'
import type { ProcessControl } from '../../../../kernel/ports/processControl'
import type { Scheduler } from '../../../../kernel/ports/scheduler'
import {
  POWERSHELL_ARGS,
  TMUX_LIST_PANES_ARGS,
  parsePidTty,
  parseTmuxPanes,
  powerShellStdinLine,
  tmuxPaneOn,
  ttyOfArgs
} from './consoleKeys'
import {
  SUBMIT_SPLIT_DELAY_MS,
  relayPayloadOf,
  type RelayPayload,
  terminalTabTextArgs,
  tmuxLoadBufferArgs,
  tmuxPasteArgs,
  tmuxSubmitArgs,
  windowsTextWriteScript
} from './consoleText'
import {
  DEFAULT_COMMANDS,
  runTool,
  targetNow,
  toolEnvironment,
  type ConsoleCommand,
  type ConsoleTool,
  type ToolRun
} from './consoleTools'

/** The bound on one tool run; measured message writes take about 250 ms (#371). */
export const OBSERVED_TEXT_WRITE_TIMEOUT_MS = 20_000

export type TextWriteOutcome = 'written' | 'not-targeted' | 'gone' | 'incomplete'

export interface ConsoleTextDeliveryDeps {
  /** The kernel process port: the identity probe and every tool run (R17). */
  processes: Pick<ProcessControl, 'probe' | 'spawn' | 'killTree'>
  /** The OS the Host runs on, passed in by the composition root (R18). */
  platform: NodeJS.Platform
  /** The Host's environment; each tool gets only TOOL_ENV_NAMES of it (06 INV-59, ADR-013). */
  env: Readonly<Record<string, string | undefined>>
  /** The working folder each tool runs in. */
  cwd: string
  scheduler: Scheduler
  /** Overrides of the tools' executables (the OS lane points them at stubs). */
  commands?: Partial<Record<ConsoleTool, ConsoleCommand>>
  timeoutMs?: number
}

/** A probe that is not `same`, as the outcome of the write it stopped. */
const STOPPED = { gone: 'gone', unreadable: 'not-targeted' } as const

export class ConsoleTextDelivery {
  constructor(private readonly deps: ConsoleTextDeliveryDeps) {}

  /**
   * Types `text` into the terminal of the process `target` and submits it, or writes nothing. Each
   * of `paths` (Host-revalidated, #1463) goes first as a bracketed paste (`relayPayloadOf`); one
   * that no terminal can take whole means nothing at all is written.
   */
  async write(
    target: ProcessIdentity,
    text: string,
    paths: readonly string[] = []
  ): Promise<TextWriteOutcome> {
    const payload = relayPayloadOf(text, paths)
    if (payload === null) return 'not-targeted'
    try {
      switch (this.deps.platform) {
        case 'win32':
          return await this.writeToConsole(target, payload)
        case 'darwin':
        case 'linux':
          // One paste carries both: the files' markers, then the words (legacy, #408).
          return await this.writeToTerminalOfTty(target, payload.pastes.join('') + payload.words)
        default:
          return 'not-targeted'
      }
    } catch {
      return 'incomplete'
    }
  }

  private async writeToConsole(
    target: ProcessIdentity,
    payload: RelayPayload
  ): Promise<TextWriteOutcome> {
    const script = windowsTextWriteScript(target.pid, payload.words, payload.pastes)
    if (script === null) return 'not-targeted'
    const now = await targetNow(this.deps.processes, target)
    if (now !== 'same') return STOPPED[now]
    const run = await this.run('powershell', POWERSHELL_ARGS, powerShellStdinLine(script))
    if (run.kind === 'not-started') return 'not-targeted'
    if (run.kind === 'overran') return 'incomplete'
    // 2: the attach was refused, 3: `CONIN$` would not open — both before any write.
    if (run.code === 0) return 'written'
    return run.code === 2 || run.code === 3 ? 'not-targeted' : 'incomplete'
  }

  private async writeToTerminalOfTty(
    target: ProcessIdentity,
    relay: string
  ): Promise<TextWriteOutcome> {
    const ttyArgs = ttyOfArgs(target.pid)
    if (ttyArgs === null) return 'not-targeted'
    const ttyRun = await this.run('ps', ttyArgs)
    const tty = exitedZero(ttyRun) ? parsePidTty(ttyRun.stdout) : null
    if (tty === null) return 'not-targeted'

    const panesRun = await this.run('tmux', TMUX_LIST_PANES_ARGS)
    const pane = exitedZero(panesRun) ? tmuxPaneOn(tty, parseTmuxPanes(panesRun.stdout)) : null
    if (pane !== null) return this.writeToPane(target, pane, relay)
    if (this.deps.platform !== 'darwin') return 'not-targeted'

    const tabArgs = terminalTabTextArgs(tty, relay)
    if (tabArgs === null) return 'not-targeted'
    const now = await targetNow(this.deps.processes, target)
    if (now !== 'same') return STOPPED[now]
    const run = await this.run('osascript', tabArgs)
    if (run.kind === 'overran') return 'incomplete'
    // The script errors before its write when no tab is on that tty (or Automation is refused).
    return exitedZero(run) ? 'written' : 'not-targeted'
  }

  private async writeToPane(
    target: ProcessIdentity,
    pane: string,
    relay: string
  ): Promise<TextWriteOutcome> {
    const paste = tmuxPasteArgs(pane)
    const submit = tmuxSubmitArgs(pane)
    if (paste === null || submit === null) return 'not-targeted'
    // Into DwarfAI's own named buffer: no terminal is written yet.
    if (!exitedZero(await this.run('tmux', tmuxLoadBufferArgs(), relay))) return 'not-targeted'
    const now = await targetNow(this.deps.processes, target)
    if (now !== 'same') return STOPPED[now]
    if (!exitedZero(await this.run('tmux', paste))) return 'incomplete'
    await this.pause(SUBMIT_SPLIT_DELAY_MS)
    if ((await targetNow(this.deps.processes, target)) !== 'same') return 'incomplete'
    return exitedZero(await this.run('tmux', submit)) ? 'written' : 'incomplete'
  }

  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => this.deps.scheduler.after(ms, resolve))
  }

  private run(tool: ConsoleTool, args: readonly string[], stdin = ''): Promise<ToolRun> {
    return runTool(this.deps, this.deps.commands?.[tool] ?? DEFAULT_COMMANDS[tool], args, {
      env: toolEnvironment(this.deps.env),
      stdin,
      timeoutMs: this.deps.timeoutMs ?? OBSERVED_TEXT_WRITE_TIMEOUT_MS
    })
  }
}

function exitedZero(run: ToolRun): run is Extract<ToolRun, { kind: 'exited' }> {
  return run.kind === 'exited' && run.code === 0
}
