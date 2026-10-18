// CandidateAutostart: the `CandidateLoginEntry` adapter of the window module (21 §2 cut 1, "Login autostart entry"),
// today's per-OS autostart entry ported unchanged from `src/main/platform/autostartPorts.ts` so UI main owns it before
// the legacy runtime is deleted (ISSUE-243). Its per-OS branches live here only (R18):
//
// - Windows: the `DwarfAI-Miners` REG_SZ value under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, through
//   `reg.exe` (the `RegRunner` the root hands in; it runs `shell: false`). Nothing else is touched: the person's
//   switch in Task Manager's "Startup apps" (`StartupApproved\Run`) is left as it is. The one-time migration removes a
//   pre-rename `AgentName` value and writes the new one when the old one was there.
// - macOS: a per-user LaunchAgent, `~/Library/LaunchAgents/com.jeronimorepetto.dwarfaiminers.plist`.
// - Linux: an XDG autostart entry, `$XDG_CONFIG_HOME/autostart/dwarfai-miners.desktop` (`~/.config` when unset or
//   relative, as the base-directory spec says).
//
// `enable` rejects when the OS refuses, so the caller's default marker is not written. The default marker is the file
// `autostart-default-v1.marker` in Electron's userData, holding `autostart-default-v1`.
import { access, mkdir, writeFile } from 'node:fs/promises'
import { posix } from 'node:path'
import {
  CANDIDATE_AUTOSTART_LABEL,
  CANDIDATE_AUTOSTART_NAME,
  CANDIDATE_DESKTOP_FILE,
  CANDIDATE_LEGACY_RUN_NAME,
  buildDesktopEntry,
  buildLaunchAgentPlist,
  buildWindowsRunValue,
  planAutostartMigration,
  type LaunchCommand
} from '../../domain/candidateLoginEntry'
import type { CandidateDefaultMarker, CandidateLoginEntry } from '../../ports/candidateLoginEntry'

/** Runs `reg.exe` with these arguments; rejects when the command fails. */
export type RegRunner = (args: string[]) => Promise<void>

/** The file write the macOS and Linux entries need (Node's in production; a model in tests). */
export interface CandidateAutostartFs {
  /** Writes `content`, creating any missing parent folder. */
  writeFile(path: string, content: string): Promise<void>
}

export const nodeCandidateAutostartFs: CandidateAutostartFs = {
  async writeFile(path, content) {
    await mkdir(posix.dirname(path), { recursive: true })
    await writeFile(path, content, 'utf8')
  }
}

export interface CandidateAutostartOptions {
  /** The OS this process runs on (read by the composition root). */
  platform: 'win32' | 'darwin' | 'linux'
  /** What the entry starts: the packaged app's executable, with no arguments. */
  command: LaunchCommand
  /** The person's home folder and environment (macOS and Linux: where the entry goes). */
  home: string
  env: Readonly<Record<string, string | undefined>>
  /** `reg.exe` (Windows). */
  reg: RegRunner
  fs?: CandidateAutostartFs
}

export const CANDIDATE_RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'

/** ~/Library/LaunchAgents/<label>.plist: the per-user location, no privileges needed. */
export function launchAgentPlistPath(home: string): string {
  return posix.join(home, 'Library', 'LaunchAgents', `${CANDIDATE_AUTOSTART_LABEL}.plist`)
}

/** `$XDG_CONFIG_HOME/autostart/…`; a relative or empty value is invalid and treated as unset (XDG base dirs). */
export function xdgAutostartPath(
  home: string,
  env: Readonly<Record<string, string | undefined>>
): string {
  const configured = env.XDG_CONFIG_HOME
  const configHome =
    configured !== undefined && configured.startsWith('/')
      ? configured
      : posix.join(home, '.config')
  return posix.join(configHome, 'autostart', CANDIDATE_DESKTOP_FILE)
}

/** One entry file, written to turn the entry on (macOS and Linux differ only in where it goes and what it holds). */
function fileEntry(path: string, content: string, fs: CandidateAutostartFs): CandidateLoginEntry {
  return {
    enable: () => fs.writeFile(path, content),
    // No macOS or Linux build shipped before the rename, so there is no pre-rename entry to clean up.
    migrateLegacy: async () => {}
  }
}

/** Windows: the Run value, through `reg.exe`. */
function runValueEntry(command: LaunchCommand, reg: RegRunner): CandidateLoginEntry {
  async function valueExists(name: string): Promise<boolean> {
    try {
      await reg(['query', CANDIDATE_RUN_KEY, '/v', name])
      return true
    } catch {
      return false
    }
  }

  async function deleteValue(name: string): Promise<void> {
    try {
      await reg(['delete', CANDIDATE_RUN_KEY, '/v', name, '/f'])
    } catch {
      // The value is not there: already gone.
    }
  }

  async function writeValue(): Promise<void> {
    await reg([
      'add',
      CANDIDATE_RUN_KEY,
      '/v',
      CANDIDATE_AUTOSTART_NAME,
      '/t',
      'REG_SZ',
      '/d',
      buildWindowsRunValue(command),
      '/f'
    ])
  }

  return {
    enable: writeValue,
    async migrateLegacy() {
      // The legacy value's presence is the only "was it on" signal before it is removed, so both inputs share one read.
      const legacyValuePresent = await valueExists(CANDIDATE_LEGACY_RUN_NAME)
      const plan = planAutostartMigration({
        legacyValuePresent,
        autostartEnabled: legacyValuePresent
      })
      if (plan.deleteLegacy) await deleteValue(CANDIDATE_LEGACY_RUN_NAME)
      if (plan.writeNew) await writeValue()
    }
  }
}

export function candidateLoginEntryFor(options: CandidateAutostartOptions): CandidateLoginEntry {
  const fs = options.fs ?? nodeCandidateAutostartFs
  switch (options.platform) {
    case 'win32':
      return runValueEntry(options.command, options.reg)
    case 'darwin':
      return fileEntry(
        launchAgentPlistPath(options.home),
        buildLaunchAgentPlist(options.command),
        fs
      )
    case 'linux':
      return fileEntry(
        xdgAutostartPath(options.home, options.env),
        buildDesktopEntry(options.command),
        fs
      )
  }
}

const DEFAULT_MARKER = 'autostart-default-v1'

/** The default marker file (`ensureDefaultAutostart`'s, unchanged): written once, never overwritten (`wx`). */
export function candidateDefaultMarkerAt(path: string): CandidateDefaultMarker {
  return {
    async exists() {
      try {
        await access(path)
        return true
      } catch {
        return false
      }
    },
    async write() {
      await writeFile(path, `${DEFAULT_MARKER}\n`, { encoding: 'utf8', flag: 'wx' })
    }
  }
}
