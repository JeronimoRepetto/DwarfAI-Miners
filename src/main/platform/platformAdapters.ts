import { homedir } from 'node:os'
import { NodeFs } from '../adapters/fsLike'
import type { FsLike } from '../adapters/fsLike'
import { createCliDetector, type AgentCli, type CliDetector } from './cliDetection'
import { createProcessProbe, type ProbeRunner, type ProcessProbePort } from './processProbe'
import { createProcessEnd, type EndProcessRunner, type ProcessEndPort } from './processEnd'
import { focusPid as windowsFocusPid, type ShellRunner } from './focus'
import {
  launchTranscriptViewer,
  resolveViewerScriptPath,
  type SpawnFn,
  type ViewerPathOptions
} from './terminalLauncher'
import {
  createOsascriptConsoleInput,
  type ConsoleInputAdapter
} from '../textDelivery/osascriptInput'
import type { ClipboardPort, TextDeliveryPort } from '../textDelivery/port'
import { PosixTextDelivery } from '../textDelivery/posixTextDelivery'
import type { CodexQueueRunner } from '../textDelivery/codexQueue'
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
 * Whether the macOS console-input path (System Events keystrokes) is offered.
 *
 * The osascript builders are unit-tested, but nothing here has been run on a
 * real Mac, and System Events additionally requires the user to grant
 * Accessibility permission — which this app cannot detect. Offering an
 * unverified channel would mean a Send button that appears to work and
 * silently types nowhere, so it stays off and the panel shows the honest
 * disabled button with its reason. Flip it (and the README support matrix)
 * once it has been verified end to end on macOS.
 */
export const DARWIN_CONSOLE_INPUT_ENABLED = false

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
  /** Overrides DARWIN_CONSOLE_INPUT_ENABLED; for tests and a future opt-in. */
  darwinConsoleInput?: boolean
  /** Injected for tests; defaults to a real powershell.exe run. */
  runShell?: ShellRunner
  /**
   * The system clipboard the Windows paste path uses (#319), composed from
   * Electron's `clipboard` at the app's root and passed in — this module holds
   * no Electron import, exactly as it holds none for the launch command
   * (autostart). Absent, the Windows port falls back to a process-local
   * clipboard, harmless for a build that never pastes.
   */
  clipboard?: ClipboardPort
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
  const enabled = options.darwinConsoleInput ?? DARWIN_CONSOLE_INPUT_ENABLED
  if (platform !== 'darwin' || !enabled) return null
  return createOsascriptConsoleInput(options.runCommand ?? runUnixCommand)
}

function createTextDelivery(
  platform: Platform,
  options: PlatformAdapterOptions,
  focus: (pid: number) => Promise<boolean>,
  cliDetector: CliDetector
): TextDeliveryPort {
  const shared = {
    home: options.home,
    relayModel: options.relayModel,
    relayTimeoutMs: options.relayTimeoutMs,
    focus,
    // The Codex queue tier addresses the binary the detection port found (#91),
    // so CODEX_CLI_PATH reaches it and no second install-location guess exists.
    // Asked per delivery rather than resolved once: the detector caches with a
    // TTL, and a codex installed after the app started must still be found.
    codexBinary: async (): Promise<string | undefined> => {
      const detection = await cliDetector.detect('codex')
      return detection.installed ? detection.path : undefined
    },
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.runRelay === undefined ? {} : { runRelay: options.runRelay }),
    ...(options.runCodexQueue === undefined ? {} : { runCodexQueue: options.runCodexQueue })
  }
  if (platform === 'win32') {
    return new WindowsTextDelivery({
      ...shared,
      ...(options.runShell === undefined ? {} : { runPowerShell: options.runShell }),
      ...(options.clipboard === undefined ? {} : { clipboard: options.clipboard })
    })
  }
  return new PosixTextDelivery({
    ...shared,
    platform,
    consoleInput: createConsoleInput(platform, options)
  })
}

/** Build every platform-specific adapter this app needs, for one platform. */
export function createPlatformAdapters(options: PlatformAdapterOptions): PlatformAdapters {
  const platform = options.platform ?? currentPlatform()
  const focus = createFocus(platform, options)
  const viewerScriptPath = resolveViewerScriptPath(options.appPaths, platform)
  const nodePath = options.nodePath ?? process.execPath
  // Built before the delivery port, which asks it for the codex binary (#97).
  const cliDetector = createCliDetector({
    home: options.home,
    platform,
    fs: options.fs ?? new NodeFs(),
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
    textDelivery: createTextDelivery(platform, options, focus, cliDetector),
    processProbe: createProcessProbe({
      platform,
      ...(options.probeRun === undefined ? {} : { run: options.probeRun })
    }),
    processEnd: createProcessEnd({
      platform,
      ...(options.endRun === undefined ? {} : { run: options.endRun })
    }),
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
