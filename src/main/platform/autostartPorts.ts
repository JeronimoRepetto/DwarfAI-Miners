import { execFile } from 'node:child_process'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import {
  AUTOSTART_APP_NAME,
  buildDesktopEntry,
  buildLaunchAgentPlist,
  buildWindowsRunValue,
  launchAgentPlistPath,
  xdgAutostartPath,
  type LaunchCommand
} from './autostartEntries'

const execFileAsync = promisify(execFile)

/**
 * "Start at login", once per platform.
 *
 * All three implementations take a LaunchCommand rather than reading it
 * themselves, which is what keeps this module free of any Electron import: the
 * caller (src/main/autostart.ts) knows whether the app is packaged and where
 * it lives, and this module knows only how each operating system is told about
 * it.
 */
export interface AutostartPort {
  /** Rejects on failure — the caller's first-run marker depends on that. */
  enable(command: LaunchCommand): Promise<void>
  disable(): Promise<void>
  isEnabled(): Promise<boolean>
  /**
   * One-time cleanup of an older release's autostart entry. Only Windows ever
   * shipped one (as 'AgentName'), so this is a no-op everywhere else.
   */
  migrateLegacy(
    warn: (message: string, error: unknown) => void,
    command?: LaunchCommand
  ): Promise<void>
}

/** The file operations the POSIX adapters need, injected so tests touch no disk. */
export interface AutostartFsLike {
  /** Writes `content`, creating any missing parent directory. */
  writeFile(path: string, content: string): Promise<void>
  /** Removes the file; resolves quietly when it is already gone. */
  removeFile(path: string): Promise<void>
  fileExists(path: string): Promise<boolean>
}

export const nodeAutostartFs: AutostartFsLike = {
  async writeFile(path, content) {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content, 'utf8')
  },
  async removeFile(path) {
    await rm(path, { force: true })
  },
  async fileExists(path) {
    try {
      await stat(path)
      return true
    } catch {
      return false
    }
  }
}

/**
 * One entry file, written to enable and removed to disable. macOS
 * (LaunchAgents plist) and Linux (XDG autostart .desktop) differ only in where
 * the file goes and what is in it.
 */
function createFileAutostart(
  path: string,
  render: (command: LaunchCommand) => string,
  fs: AutostartFsLike
): AutostartPort {
  return {
    enable: (command) => fs.writeFile(path, render(command)),
    disable: () => fs.removeFile(path),
    isEnabled: () => fs.fileExists(path),
    migrateLegacy: async () => {
      // No macOS or Linux build shipped before the DwarfAI-Miners rename, so
      // there is no legacy entry that could exist to clean up.
    }
  }
}

export interface PosixAutostartOptions {
  home: string
  fs?: AutostartFsLike
}

/** macOS: a per-user launchd agent in ~/Library/LaunchAgents. */
export function createMacAutostart(options: PosixAutostartOptions): AutostartPort {
  return createFileAutostart(
    launchAgentPlistPath(options.home),
    buildLaunchAgentPlist,
    options.fs ?? nodeAutostartFs
  )
}

export interface LinuxAutostartOptions extends PosixAutostartOptions {
  env: NodeJS.ProcessEnv
}

/** Linux: an XDG autostart entry in ~/.config/autostart. */
export function createLinuxAutostart(options: LinuxAutostartOptions): AutostartPort {
  return createFileAutostart(
    xdgAutostartPath(options.home, options.env),
    buildDesktopEntry,
    options.fs ?? nodeAutostartFs
  )
}

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
/** Pre-rename Run value name, kept only to migrate existing installs away from it. */
const LEGACY_VALUE_NAME = 'AgentName'

/** Runs `reg` with these arguments; rejects when the command fails. */
export type RegRunner = (args: string[]) => Promise<void>

const runReg: RegRunner = async (args) => {
  await execFileAsync('reg', args)
}

export interface AutostartMigrationState {
  /** Whether the legacy 'AgentName' Run value is currently present in the registry. */
  legacyValuePresent: boolean
  /** Whether autostart was enabled, checked before the legacy value is touched. */
  autostartEnabled: boolean
}

export interface AutostartMigrationPlan {
  /** Remove the legacy 'AgentName' Run value. */
  deleteLegacy: boolean
  /** (Re)write the 'DwarfAI-Miners' Run value. */
  writeNew: boolean
}

/**
 * Pure decision table for the one-time 'AgentName' -> 'DwarfAI-Miners' Run
 * value rename.
 *
 * | legacyValuePresent | autostartEnabled | deleteLegacy | writeNew |
 * | ------------------ | ---------------- | ------------ | -------- |
 * | false               | false            | false        | false    |
 * | false               | true             | false        | false    |
 * | true                | false            | true         | false    |
 * | true                | true             | true         | true     |
 *
 * A legacy value, once found, is always removed (rows 3-4). The new value is
 * written only when autostart was actually on (row 4), so a user who had
 * opted out stays opted out under the new name. This is naturally
 * idempotent: once the legacy value is gone, every later startup observes
 * legacyValuePresent = false and does nothing further.
 */
export function planAutostartMigration(state: AutostartMigrationState): AutostartMigrationPlan {
  return {
    deleteLegacy: state.legacyValuePresent,
    writeNew: state.legacyValuePresent && state.autostartEnabled
  }
}

export interface WindowsAutostartOptions {
  /** Injected for tests; defaults to a real `reg` spawn. */
  run?: RegRunner
}

/** Windows: a value under HKCU\...\CurrentVersion\Run. */
export function createWindowsAutostart(options: WindowsAutostartOptions = {}): AutostartPort {
  const run = options.run ?? runReg

  async function valueExists(valueName: string): Promise<boolean> {
    try {
      await run(['query', RUN_KEY, '/v', valueName])
      return true
    } catch {
      return false
    }
  }

  async function deleteValue(valueName: string): Promise<void> {
    try {
      await run(['delete', RUN_KEY, '/v', valueName, '/f'])
    } catch {
      // Value not present — already gone.
    }
  }

  async function writeValue(command: LaunchCommand): Promise<void> {
    await run([
      'add',
      RUN_KEY,
      '/v',
      AUTOSTART_APP_NAME,
      '/t',
      'REG_SZ',
      '/d',
      buildWindowsRunValue(command),
      '/f'
    ])
  }

  return {
    enable: writeValue,
    disable: () => deleteValue(AUTOSTART_APP_NAME),
    isEnabled: () => valueExists(AUTOSTART_APP_NAME),
    async migrateLegacy(warn, command) {
      if (command === undefined) return
      try {
        const legacyValuePresent = await valueExists(LEGACY_VALUE_NAME)
        // The legacy value's presence is the only "was autostart enabled"
        // signal available before it is removed, so both plan inputs share
        // one read.
        const plan = planAutostartMigration({
          legacyValuePresent,
          autostartEnabled: legacyValuePresent
        })
        if (plan.deleteLegacy) await deleteValue(LEGACY_VALUE_NAME)
        if (plan.writeNew) await writeValue(command)
      } catch (error) {
        warn('[autostart] Failed to migrate legacy AgentName autostart entry:', error)
      }
    }
  }
}
