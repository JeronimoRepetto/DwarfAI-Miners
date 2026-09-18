import { homedir } from 'node:os'
import { NodeFs } from '../adapters/fsLike'
import type { FsLike } from '../adapters/fsLike'
import { createCliDetector, type AgentCli, type CliDetector } from './cliDetection'
import { createProcessProbe, type ProbeRunner, type ProcessProbePort } from './processProbe'
import { createProcessEnd, type EndProcessRunner, type ProcessEndPort } from './processEnd'
import { focusPid as windowsFocusPid, focusSessionConsole, type ShellRunner } from './focus'
import {
  launchTranscriptViewer,
  resolveViewerScriptPath,
  type SpawnFn,
  type ViewerPathOptions
} from './terminalLauncher'
import type { ConsoleInputAdapter } from '../textDelivery/osascriptInput'
import { createDarwinConsoleInput } from '../textDelivery/darwinConsoleInput'
import { createTmuxConsoleInput } from '../textDelivery/tmuxConsoleInput'
import type { TextDeliveryPort } from '../textDelivery/port'
import { PosixTextDelivery } from '../textDelivery/posixTextDelivery'
import type { CodexQueueRunner } from '../textDelivery/codexQueue'
import type { CodexResumeRunner } from '../textDelivery/codexResume'
import type { RelayRunner } from '../textDelivery/relayRunner'
import { WindowsTextDelivery } from '../textDelivery/windowsTextDelivery'
import {
  createLinuxAutostart,
  createMacAutostart,
  createWindowsAutostart,
  type AutostartFsLike,
  type AutostartPort,
  type RegRunner
} from './autostartPorts'
import { currentPlatform, type Platform } from './platform'
import {
  createDarwinFocus,
  createUnsupportedFocus,
  runUnixCommand,
  type CommandRunner
} from './unixFocus'

export type { Platform }

/**
 * The single composition point for everything that differs per operating
 * system.
 *
 * Every per-OS branch in this app lives here and nowhere else: the rest of the
 * code depends on ports (a focus function, a TextDeliveryPort, a
 * ProcessProbePort, an AutostartPort) and never asks what it is running on.
 * That is what makes the whole app testable from Windows for platforms that
 * cannot be executed here — the selection itself is unit-tested below, and
 * each adapter is unit-tested against its own pure builders.
 */

/**
 * Whether the macOS console-input path is offered by default.
 *
 * What it gates is two mechanisms, not one (#367 item 2, and see
 * `darwinConsoleInput.ts`). A MESSAGE is written into the Terminal.app tab the
 * session's tty names — measured live 2026-09-18, no window raised, no
 * keystroke synthesized, Automation permission only. A key that must not carry
 * a Return — #203's permission digit, and the Escape behind a deny — is still a
 * System Events keystroke at the foreground, and still needs Accessibility
 * permission this app cannot detect, and a foregrounded window.
 *
 * The reach verdict #367 asked for is what makes this safe: `darwinTabReach.ts`
 * answers `own-console` for a tty a Terminal.app tab carries and
 * `terminal-host` for everything else, which is the same refusal the Windows
 * port makes for a shared tab strip (#329). A message can no longer land in
 * the wrong tab, because no tab is guessed at — it is addressed. A session
 * hosted anywhere other than a Terminal.app tab still answers `terminal-host`
 * and its message still goes by relay, exactly as before this flipped.
 *
 * The maintainer chose this default `true` on 2026-09-18 ("DARWIN_CONSOLE_INPUT
 * debe venir activado por defecto", #367), before the end-to-end walk from the
 * panel — Terminal.app is still the ONLY host measured; iTerm2, WezTerm,
 * Alacritty, kitty, Ghostty, Hyper and Warp all fall back to `terminal-host`
 * until somebody measures them, which the tty-ownership check above already
 * guarantees rather than trusting this flag alone. `DARWIN_CONSOLE_INPUT` in
 * config.ts's `darwinConsoleInputOverride` (documented beside the other
 * diagnostic switches in docs/guide.md) is the way back: `=0`/`=false` forces
 * this OFF for one run, `=1`/`=true` forces it ON, unset leaves this constant
 * in charge. Wired in through the `darwinConsoleInput` option below, at
 * index.ts's composition root.
 */
export const DARWIN_CONSOLE_INPUT_ENABLED = true

/**
 * Whether the Linux console-input path is offered by default.
 *
 * What it gates is ONE mechanism, not the two above: the tmux pane write
 * (`tmuxConsoleInput.ts`). Linux has no second tier here — a keystroke tier
 * needs a reach verdict nobody has measured, and #329 is the name of what
 * happens without one — so the adapter refuses `sendText` and `sendInterrupt`
 * by name and the port above states that refusal, exactly as it did when there
 * was no adapter at all.
 *
 * **Default `true`, and the decision is the maintainer's of 2026-09-18**:
 * build everything a pure builder can carry, ship it on, and let the
 * measurements correct it. What makes that safe rather than optimistic is the
 * same thing that made it safe on macOS — the reach verdict. A session in a
 * tmux pane is ADDRESSED; a session in any other terminal, or in none, answers
 * `terminal-host` and its message goes by relay exactly as it did before this
 * existed. So nothing gets worse for a person who does not use tmux, and the
 * cost of being wrong is bounded by a verdict rather than by this flag.
 *
 * **Unmeasured on a real Linux desktop.** No command on this path has been run
 * against a live tmux, on Linux or anywhere else: the command shapes come from
 * tmux's documented interface and the payload shapes from what #404/#485
 * measured about the receiving TUI. README's Linux cells say "built,
 * unmeasured" and must not say Verified until somebody walks the checklist in
 * `docs/console-hosting.md`. `LINUX_CONSOLE_INPUT` in config.ts's
 * `linuxConsoleInputOverride` is the way back: `=0`/`=false` forces this OFF
 * for one run, `=1`/`=true` forces it ON, unset leaves this constant in
 * charge. Wired in through the `linuxConsoleInput` option below.
 */
export const LINUX_CONSOLE_INPUT_ENABLED = true

export interface PlatformAdapters {
  platform: Platform
  /** Brings the terminal window hosting `pid` to the foreground. */
  focusPid(pid: number): Promise<boolean>
  /** Opens a terminal window tailing a dwarf's transcript live. */
  launchTranscriptViewer(dwarfName: string, transcriptPath: string): Promise<boolean>
  /** Where the viewer script that terminal runs lives, exposed for diagnostics and tests. */
  viewerScriptPath: string
  textDelivery: TextDeliveryPort
  processProbe: ProcessProbePort
  /** Ends a process and everything below it — the exit from a launched session (#217). */
  processEnd: ProcessEndPort
  /** Which agent CLIs are installed on this machine, and where (#91). */
  cliDetector: CliDetector
}

export interface PlatformAdapterOptions {
  platform?: Platform
  home: string
  /** Electron packaging info, used to resolve the transcript-viewer script path. */
  appPaths: ViewerPathOptions
  /** Cheap model the one-shot relay turn runs on. */
  relayModel: string
  relayTimeoutMs: number
  /** Node-capable binary the POSIX viewer's formatter runs on; defaults to this process's. */
  nodePath?: string
  env?: NodeJS.ProcessEnv
  /**
   * Overrides DARWIN_CONSOLE_INPUT_ENABLED; for tests, and for the
   * `DARWIN_CONSOLE_INPUT` two-way override index.ts feeds in from the real
   * environment (#367 items 1 and 3).
   */
  darwinConsoleInput?: boolean
  /**
   * Overrides LINUX_CONSOLE_INPUT_ENABLED; for tests, and for the
   * `LINUX_CONSOLE_INPUT` two-way override index.ts feeds in from the real
   * environment (#471). Separate from the macOS one on purpose: two tiers,
   * two measurement states, two people who may want one off.
   */
  linuxConsoleInput?: boolean
  /** Injected for tests; defaults to a real powershell.exe run. */
  runShell?: ShellRunner
  /** Injected for tests; defaults to a real ps/osascript run. */
  runCommand?: CommandRunner
  /** Injected for tests; defaults to a real process-list probe. */
  probeRun?: ProbeRunner
  /** Injected for tests; defaults to a real taskkill/kill run (#217). */
  endRun?: EndProcessRunner
  /** Injected for tests; defaults to node:child_process.spawn. */
  spawn?: SpawnFn
  /** Injected for tests; defaults to a real claude spawn. */
  runRelay?: RelayRunner
  /** Injected for tests; defaults to a real codex spawn (#97). */
  runCodexQueue?: CodexQueueRunner
  /** Injected for tests; defaults to a real codex spawn (#450). */
  runCodexResume?: CodexResumeRunner
  /** Explicit binary paths that override CLI detection; blank means "detect it" (#91). */
  cliOverrides?: Partial<Record<AgentCli, string>>
  /** Injected for tests; defaults to the real filesystem, used by CLI detection. */
  fs?: FsLike
}

function createFocus(
  platform: Platform,
  options: PlatformAdapterOptions
): (pid: number) => Promise<boolean> {
  if (platform === 'win32') {
    const run = options.runShell
    return run === undefined ? windowsFocusPid : (pid) => windowsFocusPid(pid, run)
  }
  if (platform === 'darwin') {
    return createDarwinFocus(options.runCommand ?? runUnixCommand)
  }
  return createUnsupportedFocus()
}

function createConsoleInput(
  platform: Platform,
  options: PlatformAdapterOptions
): ConsoleInputAdapter | null {
  const run = options.runCommand ?? runUnixCommand
  if (platform === 'linux') {
    // One mechanism, and the only one Linux has (#471): the tmux pane write.
    // A session outside tmux is refused by the adapter's own reach verdict and
    // its message goes by relay, so this is offered to everybody and costs
    // nothing to a machine that does not run tmux.
    return (options.linuxConsoleInput ?? LINUX_CONSOLE_INPUT_ENABLED)
      ? createTmuxConsoleInput(run)
      : null
  }
  const enabled = options.darwinConsoleInput ?? DARWIN_CONSOLE_INPUT_ENABLED
  if (platform !== 'darwin' || !enabled) return null
  // Two mechanisms behind one adapter since #367, and which one an act takes is
  // decided there rather than here: a MESSAGE is written into the Terminal.app
  // tab its tty names, and a key that must not carry a Return stays on System
  // Events. `createOsascriptConsoleInput` is what this composed before, and it
  // is still the half that presses keys.
  return createDarwinConsoleInput(run)
}

function createTextDelivery(
  platform: Platform,
  options: PlatformAdapterOptions,
  focus: (pid: number) => Promise<boolean>,
  cliDetector: CliDetector,
  processEnd: ProcessEndPort,
  processProbe: ProcessProbePort,
  fs: FsLike
): TextDeliveryPort {
  const shared = {
    home: options.home,
    relayModel: options.relayModel,
    relayTimeoutMs: options.relayTimeoutMs,
    // The Codex queue tier addresses the binary the detection port found (#91),
    // so CODEX_CLI_PATH reaches it and no second install-location guess exists.
    // Asked per delivery rather than resolved once: the detector caches with a
    // TTL, and a codex installed after the app started must still be found.
    codexBinary: async (): Promise<string | undefined> => {
      const detection = await cliDetector.detect('codex')
      return detection.installed ? detection.path : undefined
    },
    // The same FsLike instance cliDetector was built with (#413): a shim the
    // detector found is a shim this tier must be able to read too, and two
    // separate instances would still agree on every real read — sharing one is
    // simply not paying for a second object with nothing to differ over.
    fs,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.runRelay === undefined ? {} : { runRelay: options.runRelay }),
    ...(options.runCodexQueue === undefined ? {} : { runCodexQueue: options.runCodexQueue }),
    ...(options.runCodexResume === undefined ? {} : { runCodexResume: options.runCodexResume })
  }
  if (platform === 'win32') {
    // The SCOPED focus, and the one place the two part company (#329): every
    // Windows tier sends a keystroke, and a keystroke may only follow a window
    // this session is provably alone on — where the `focus` parameter above,
    // which click-to-focus and the POSIX port read, is content with either.
    // Same function underneath, same injected runner; only the answer is richer.
    const runShell = options.runShell
    return new WindowsTextDelivery({
      ...shared,
      focus:
        runShell === undefined
          ? focusSessionConsole
          : (pid: number) => focusSessionConsole(pid, runShell),
      // Kick's terminal tier ends the session's process tree (#329), through
      // the SAME port a launched session's exit uses — one per-OS tree kill,
      // composed once here, exactly as #217 left it. Passed in rather than
      // built inside the port so the injected `endRun` reaches it too. The
      // probe beside it is the re-verification before that kill (#231), and it
      // is the SAME port the Claude provider's pid-reuse guard reads, so the
      // two answers about one pid can never come from two different probes.
      // Both reach the POSIX port below on identical terms (#366).
      processEnd,
      processProbe,
      ...(runShell === undefined ? {} : { runPowerShell: runShell })
    })
  }
  // Kick ends a session here too since #366, and the two ports it needs are the
  // same instances the Windows branch reads — one process-end port per OS, one
  // probe port per OS, composed once. Console input is the only capability that
  // stays platform-shaped: a keystroke needs the window server, a signal to a
  // pid needs nothing, so this port can END a session on a platform it cannot
  // TYPE into. Those two were one question until #366 and are two now.
  return new PosixTextDelivery({
    ...shared,
    focus,
    platform,
    consoleInput: createConsoleInput(platform, options),
    processEnd,
    processProbe
  })
}

/** Build every platform-specific adapter this app needs, for one platform. */
export function createPlatformAdapters(options: PlatformAdapterOptions): PlatformAdapters {
  const platform = options.platform ?? currentPlatform()
  const focus = createFocus(platform, options)
  const viewerScriptPath = resolveViewerScriptPath(options.appPaths, platform)
  const nodePath = options.nodePath ?? process.execPath
  // Built before the delivery port for the reason cliDetector is: the Windows
  // port ends a session's process tree through it (#329).
  const processEnd = createProcessEnd({
    platform,
    ...(options.endRun === undefined ? {} : { run: options.endRun })
  })
  const processProbe = createProcessProbe({
    platform,
    ...(options.probeRun === undefined ? {} : { run: options.probeRun })
  })
  // Shared with the delivery port below (#413): the same disk, the same shim
  // reads, whichever seam asks. Built before the delivery port, which asks it
  // for the codex binary (#97).
  const fs = options.fs ?? new NodeFs()
  const cliDetector = createCliDetector({
    home: options.home,
    platform,
    fs,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.cliOverrides === undefined ? {} : { overrides: options.cliOverrides })
  })

  return {
    platform,
    focusPid: focus,
    viewerScriptPath,
    launchTranscriptViewer: (dwarfName, transcriptPath) =>
      launchTranscriptViewer({
        dwarfName,
        transcriptPath,
        viewerScriptPath,
        platform,
        nodePath,
        ...(options.spawn === undefined ? {} : { spawn: options.spawn })
      }),
    textDelivery: createTextDelivery(
      platform,
      options,
      focus,
      cliDetector,
      processEnd,
      processProbe,
      fs
    ),
    processProbe,
    processEnd,
    cliDetector
  }
}

export interface AutostartPortOptions {
  platform?: Platform
  home?: string
  env?: NodeJS.ProcessEnv
  /** Injected for tests; defaults to the real filesystem. */
  fs?: AutostartFsLike
  /** Injected for tests; defaults to a real `reg` spawn. */
  regRun?: RegRunner
}

/**
 * The autostart port for one platform. Separate from createPlatformAdapters
 * because autostart is owned by the tray and the startup path, not the
 * runtime, and because its LaunchCommand comes from Electron — which this
 * module deliberately never imports (see src/main/autostart.ts).
 */
export function createAutostartPort(options: AutostartPortOptions = {}): AutostartPort {
  const platform = options.platform ?? currentPlatform()
  const home = options.home ?? homedir()
  if (platform === 'win32') {
    return createWindowsAutostart(options.regRun === undefined ? {} : { run: options.regRun })
  }
  const fs = options.fs === undefined ? {} : { fs: options.fs }
  if (platform === 'darwin') {
    return createMacAutostart({ home, ...fs })
  }
  return createLinuxAutostart({ home, env: options.env ?? process.env, ...fs })
}
