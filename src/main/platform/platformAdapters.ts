import { homedir } from 'node:os'
import {
  createProcessProbe,
  type ProbeRunner,
  type ProcessProbePort
} from '../adapters/processProbe'
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
import type { TextDeliveryPort } from '../textDelivery/port'
import { PosixTextDelivery } from '../textDelivery/posixTextDelivery'
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
  /** Injected for tests; defaults to a real ps/osascript run. */
  runCommand?: CommandRunner
  /** Injected for tests; defaults to a real process-list probe. */
  probeRun?: ProbeRunner
  /** Injected for tests; defaults to node:child_process.spawn. */
  spawn?: SpawnFn
  /** Injected for tests; defaults to a real claude spawn. */
  runRelay?: RelayRunner
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
  focus: (pid: number) => Promise<boolean>
): TextDeliveryPort {
  const shared = {
    home: options.home,
    relayModel: options.relayModel,
    relayTimeoutMs: options.relayTimeoutMs,
    focus,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.runRelay === undefined ? {} : { runRelay: options.runRelay })
  }
  if (platform === 'win32') {
    return new WindowsTextDelivery({
      ...shared,
      ...(options.runShell === undefined ? {} : { runPowerShell: options.runShell })
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
    textDelivery: createTextDelivery(platform, options, focus),
    processProbe: createProcessProbe({
      platform,
      ...(options.probeRun === undefined ? {} : { run: options.probeRun })
    })
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
