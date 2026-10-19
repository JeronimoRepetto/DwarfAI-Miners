// The observed-session key relay (ADR-012 item 3, 15 §3.3; the "target checked just before
// writing" rule ISSUE-167's ObservedSessionTurnSender shares): presses ONE key — a digit or Esc —
// in the terminal of a session the person started themselves, and only there. Pulled forward from
// ISSUE-167 as the cut-2 slice the observed-Claude keystroke channel needs (#1285, lead decision
// 2026-10-14); TurnSender, delivery marks and the message path stay with ISSUE-167.
//
// The target is the session's process identity as observation recorded it (pid + start time +
// boot, ADR-014 item 1), never a bare pid. The terminal is resolved first (reads only), then the
// identity is probed AGAIN immediately before the one write: a process that is gone, recycled, of
// an earlier boot, or whose start time cannot be read is never written to (06 INV-51; `unknown` is
// a mismatch). What remains is the spawn of the writing tool itself, a few hundred milliseconds.
//
// Per OS (builders in consoleKeys.ts, candidate decisions in its header):
// - Windows: a hidden PowerShell child attaches to the session's console by pid and writes the key
//   into its input buffer (no window raised, the foreground untouched, no tab ambiguity).
// - macOS and Linux: the tmux pane on the session's tty (`send-keys`, digit literally or `Escape`);
//   on macOS, outside tmux, a digit goes into the Terminal.app tab of that tty (`do script`).
//   Anything else cannot be positively targeted: refused, nothing pressed (the card keeps "Jump to
//   terminal"). No keystroke is ever synthesized into a foreground window.
//
// Every tool runs through the kernel `ProcessControl.spawn` (R17: `shell: false` and
// `windowsHide: true` fixed by the adapter) with an argv array and the composition's environment,
// and is bounded by OBSERVED_KEY_WRITE_TIMEOUT_MS; a tool that overruns is ended by its own
// identity and the press is refused. A tool's environment is a named allowlist of the Host's. A failure of any step is `refused`: the caller (asking's
// keystroke channel) turns it into `channel-unavailable`. Nothing here logs a key or a path.
import type { ProcessIdentity } from '../../../../kernel/domain/processIdentity'
import type { ProcessControl } from '../../../../kernel/ports/processControl'
import type { Scheduler } from '../../../../kernel/ports/scheduler'
import {
  POWERSHELL_ARGS,
  TMUX_LIST_PANES_ARGS,
  isAddressableKey,
  parsePidTty,
  parseTmuxPanes,
  powerShellStdinLine,
  terminalTabKeyArgs,
  tmuxKeyArgs,
  tmuxPaneOn,
  ttyOfArgs,
  windowsKeyWriteScript,
  type ConsoleKey
} from './consoleKeys'
import {
  DEFAULT_COMMANDS,
  runTool,
  targetNow,
  toolEnvironment,
  type ConsoleCommand,
  type ConsoleTool
} from './consoleTools'

export { TOOL_ENV_NAMES, type ConsoleCommand, type ConsoleTool } from './consoleTools'

/**
 * The bound on one tool run. Below the ask broker's 30 s hand-over bound (ADR-010 item 8), so a
 * press is decided before the broker gives up on it; measured writes take about 250 ms (#371).
 */
export const OBSERVED_KEY_WRITE_TIMEOUT_MS = 20_000

export interface ConsoleKeystrokeDeliveryDeps {
  /** The kernel process port: the identity probe and every tool run (R17). */
  processes: Pick<ProcessControl, 'probe' | 'spawn' | 'killTree'>
  /** The OS the Host runs on, passed in by the composition root (R18). */
  platform: NodeJS.Platform
  /**
   * The Host's environment. Each tool gets only its TOOL_ENV_NAMES (spawn inherits nothing, 06
   * INV-59): never a token (ADR-013), a provider key or the Host's own switches.
   */
  env: Readonly<Record<string, string | undefined>>
  /** The working folder each tool runs in. */
  cwd: string
  scheduler: Scheduler
  /** Overrides of the tools' executables (the OS lane points them at stubs). */
  commands?: Partial<Record<ConsoleTool, ConsoleCommand>>
  timeoutMs?: number
}

export class ConsoleKeystrokeDelivery {
  constructor(private readonly deps: ConsoleKeystrokeDeliveryDeps) {}

  /** Presses `key` in the terminal of the process `target`, or refuses with nothing pressed. */
  async press(target: ProcessIdentity, key: ConsoleKey): Promise<'pressed' | 'refused'> {
    if (!isAddressableKey(key)) return 'refused'
    try {
      switch (this.deps.platform) {
        case 'win32':
          return await this.pressInConsole(target, key)
        case 'darwin':
        case 'linux':
          return await this.pressInTerminalOfTty(target, key)
        default:
          return 'refused'
      }
    } catch {
      return 'refused'
    }
  }

  private async pressInConsole(
    target: ProcessIdentity,
    key: ConsoleKey
  ): Promise<'pressed' | 'refused'> {
    const script = windowsKeyWriteScript(target.pid, key)
    if (script === null || !(await this.stillTheTarget(target))) return 'refused'
    const run = await this.run('powershell', POWERSHELL_ARGS, powerShellStdinLine(script))
    return run?.code === 0 ? 'pressed' : 'refused'
  }

  private async pressInTerminalOfTty(
    target: ProcessIdentity,
    key: ConsoleKey
  ): Promise<'pressed' | 'refused'> {
    const ttyArgs = ttyOfArgs(target.pid)
    if (ttyArgs === null) return 'refused'
    const ttyRun = await this.run('ps', ttyArgs)
    const tty = ttyRun?.code === 0 ? parsePidTty(ttyRun.stdout) : null
    if (tty === null) return 'refused'

    const panesRun = await this.run('tmux', TMUX_LIST_PANES_ARGS)
    const pane = panesRun?.code === 0 ? tmuxPaneOn(tty, parseTmuxPanes(panesRun.stdout)) : null
    const write: [ConsoleTool, readonly string[] | null] | null =
      pane !== null
        ? ['tmux', tmuxKeyArgs(pane, key)]
        : this.deps.platform === 'darwin'
          ? ['osascript', terminalTabKeyArgs(tty, key)]
          : null
    if (write === null || write[1] === null) return 'refused'
    if (!(await this.stillTheTarget(target))) return 'refused'
    const run = await this.run(write[0], write[1])
    return run?.code === 0 ? 'pressed' : 'refused'
  }

  /** ADR-014 item 1: only a full identity equal to the recorded one is the target. */
  private async stillTheTarget(target: ProcessIdentity): Promise<boolean> {
    return (await targetNow(this.deps.processes, target)) === 'same'
  }

  /** Runs one tool to its exit, or null when it could not start, failed, or overran its bound. */
  private async run(
    tool: ConsoleTool,
    args: readonly string[],
    stdin = ''
  ): Promise<{ code: number | null; stdout: string } | null> {
    const run = await runTool(
      this.deps,
      this.deps.commands?.[tool] ?? DEFAULT_COMMANDS[tool],
      args,
      {
        env: toolEnvironment(this.deps.env),
        stdin,
        timeoutMs: this.deps.timeoutMs ?? OBSERVED_KEY_WRITE_TIMEOUT_MS
      }
    )
    return run.kind === 'exited' ? { code: run.code, stdout: run.stdout } : null
  }
}
