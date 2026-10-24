// The console-reading capability and the navigation keys of the observed-subagent route
// (AMENDMENT-29, owner 2026-10-24): the runner of consoleScreen.ts's builders, through the kernel
// `ProcessControl` (R17: no `node:child_process` here; `shell: false` and `windowsHide: true` fixed by
// the kernel adapter), exactly as the text and key relays beside it run theirs (consoleTools.ts).
//
// - `ConsoleScreenReader.read`: the visible window of the console of a process, read through
//   `CONOUT$`; it writes nothing into the console.
// - `ConsoleNavigator.press`: one of ↓, ↑ or Enter into its `CONIN$`; no other key is expressible.
//
// The target is the lead session's process identity as observation recorded it (pid + start time +
// boot, ADR-014 item 1), probed again immediately before each read and each key: a process that is
// gone, recycled or of an earlier boot is `gone`; one whose start time cannot be read is
// `not-targeted` (INV-51). Windows only: on macOS and Linux nothing runs (`not-targeted`), as the
// route offers nothing there until it is measured (AMENDMENT-29, task S2). Nothing here logs what the
// screen showed.
import type { ProcessIdentity } from '../../../../kernel/domain/processIdentity'
import type { ProcessControl } from '../../../../kernel/ports/processControl'
import type { Scheduler } from '../../../../kernel/ports/scheduler'
import type { NavKey } from './claudeAgentPlan'
import { POWERSHELL_ARGS, powerShellStdinLine } from './consoleKeys'
import { screenLinesOf, windowsNavKeyScript, windowsScreenReadScript } from './consoleScreen'
import {
  DEFAULT_COMMANDS,
  runTool,
  targetNow,
  toolEnvironment,
  type ConsoleCommand,
  type ToolRun
} from './consoleTools'

/** The bound on one read or one key; the spike measured 270–650 ms per call. */
export const CONSOLE_SCREEN_TIMEOUT_MS = 20_000

/** What one read of a console's window gave. */
export type ScreenRead =
  | { kind: 'screen'; lines: string[] }
  /** The recorded process is not running any more (gone, recycled, an earlier boot). */
  | { kind: 'gone' }
  /** Nothing could be read: the identity unreadable, the attach or `CONOUT$` refused, no tool. */
  | { kind: 'not-targeted' }
  /** The read ran and gave no screen. */
  | { kind: 'failed' }

/** What one key press did. */
export type KeyOutcome = 'pressed' | 'gone' | 'not-targeted' | 'incomplete'

/** Reads a console's visible window (AMENDMENT-29); never writes into it. */
export interface ConsoleScreenReader {
  read(target: ProcessIdentity): Promise<ScreenRead>
}

/** Presses one navigation key into a console: ↓, ↑ or Enter, nothing else. */
export interface ConsoleNavigator {
  press(target: ProcessIdentity, key: NavKey): Promise<KeyOutcome>
}

export interface WindowsConsoleScreenDeps {
  /** The kernel process port: the identity probe and every tool run (R17). */
  processes: Pick<ProcessControl, 'probe' | 'spawn' | 'killTree'>
  /** The OS the Host runs on, passed in by the composition root (R18). */
  platform: NodeJS.Platform
  /** The Host's environment; each tool gets only TOOL_ENV_NAMES of it (06 INV-59, ADR-013). */
  env: Readonly<Record<string, string | undefined>>
  /** The working folder each tool runs in. */
  cwd: string
  scheduler: Scheduler
  /** An override of `powershell.exe` (the OS lane points it at the real one, tests at a stub). */
  powershell?: ConsoleCommand
  timeoutMs?: number
}

export class WindowsConsoleScreen implements ConsoleScreenReader, ConsoleNavigator {
  constructor(private readonly deps: WindowsConsoleScreenDeps) {}

  async read(target: ProcessIdentity): Promise<ScreenRead> {
    const script = windowsScreenReadScript(target.pid)
    if (this.deps.platform !== 'win32' || script === null) return { kind: 'not-targeted' }
    try {
      const now = await targetNow(this.deps.processes, target)
      if (now === 'gone') return { kind: 'gone' }
      if (now === 'unreadable') return { kind: 'not-targeted' }
      const run = await this.run(script)
      if (run.kind === 'not-started') return { kind: 'not-targeted' }
      if (run.kind === 'overran') return { kind: 'failed' }
      // 2: the attach was refused, 3: `CONOUT$` would not open.
      if (run.code === 2 || run.code === 3) return { kind: 'not-targeted' }
      const lines = run.code === 0 ? screenLinesOf(run.stdout) : null
      return lines === null ? { kind: 'failed' } : { kind: 'screen', lines }
    } catch {
      return { kind: 'failed' }
    }
  }

  async press(target: ProcessIdentity, key: NavKey): Promise<KeyOutcome> {
    const script = windowsNavKeyScript(target.pid, key)
    if (this.deps.platform !== 'win32' || script === null) return 'not-targeted'
    try {
      const now = await targetNow(this.deps.processes, target)
      if (now === 'gone') return 'gone'
      if (now === 'unreadable') return 'not-targeted'
      const run = await this.run(script)
      if (run.kind === 'not-started') return 'not-targeted'
      if (run.kind === 'overran') return 'incomplete'
      if (run.code === 0) return 'pressed'
      // 2: the attach was refused, 3: `CONIN$` would not open — both before any write.
      return run.code === 2 || run.code === 3 ? 'not-targeted' : 'incomplete'
    } catch {
      return 'incomplete'
    }
  }

  private run(script: string): Promise<ToolRun> {
    return runTool(
      this.deps,
      this.deps.powershell ?? DEFAULT_COMMANDS.powershell,
      POWERSHELL_ARGS,
      {
        env: toolEnvironment(this.deps.env),
        stdin: powerShellStdinLine(script),
        timeoutMs: this.deps.timeoutMs ?? CONSOLE_SCREEN_TIMEOUT_MS
      }
    )
  }
}
