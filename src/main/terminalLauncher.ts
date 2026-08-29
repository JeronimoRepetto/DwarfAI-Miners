import { spawn as nodeSpawn } from 'node:child_process'
import { join } from 'node:path'

/**
 * Click-to-focus fallback: when no existing window can be brought forward
 * (see focus.ts) — because the session is headless, or focusing failed —
 * open a real terminal window that tails the dwarf's transcript live via
 * resources/dwarf-feed-viewer.ps1. Command/path construction is pure and
 * unit-tested; actually spawning a process is integration-only.
 */

export interface ViewerPathOptions {
  isPackaged: boolean
  /** process.resourcesPath — used only when packaged. */
  resourcesPath: string
  /** app.getAppPath() (the project root pre-package, i.e. in dev). */
  appPath: string
}

/**
 * Where dwarf-feed-viewer.ps1 lives: alongside `resources/` at the project
 * root in dev, or directly under `process.resourcesPath` once packaged (see
 * `build.extraResources` in package.json, which copies resources/* there).
 */
export function resolveViewerScriptPath(options: ViewerPathOptions): string {
  return options.isPackaged
    ? join(options.resourcesPath, 'dwarf-feed-viewer.ps1')
    : join(options.appPath, 'resources', 'dwarf-feed-viewer.ps1')
}

/** Argv for `wt.exe`: a titled new tab (reuses the most recently used window, or opens one). */
export function buildWtArgs(
  title: string,
  viewerScriptPath: string,
  transcriptPath: string
): string[] {
  return [
    '-w',
    '-1',
    'new-tab',
    '--title',
    title,
    'powershell',
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    viewerScriptPath,
    '-Path',
    transcriptPath,
    '-Title',
    title
  ]
}

/**
 * Argv for a direct `powershell.exe` spawn, used when Windows Terminal isn't
 * installed. Electron's main process has no console of its own, so Windows
 * gives a spawned console-subsystem process (powershell.exe) a fresh console
 * window automatically — no extra `Start-Process` hop needed.
 */
export function buildFallbackArgs(
  title: string,
  viewerScriptPath: string,
  transcriptPath: string
): string[] {
  return [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    viewerScriptPath,
    '-Path',
    transcriptPath,
    '-Title',
    title
  ]
}

/** Minimal shape of node:child_process's ChildProcess, injected so tests never touch a real process. */
export interface SpawnedProcess {
  once(event: 'error' | 'spawn', listener: (error?: Error) => void): void
  unref(): void
}

export type SpawnFn = (command: string, args: string[]) => SpawnedProcess

function realSpawn(command: string, args: string[]): SpawnedProcess {
  return nodeSpawn(command, args, { detached: true, stdio: 'ignore', windowsHide: false })
}

/**
 * True once the process actually starts (the `spawn` event), false on any
 * error (e.g. ENOENT for a missing wt.exe). Detached + unref'd so the viewer
 * window survives independently of this app (it keeps running in the tray,
 * but there is no reason to tie the two lifecycles together).
 */
function trySpawn(spawnFn: SpawnFn, command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    let child: SpawnedProcess
    try {
      child = spawnFn(command, args)
    } catch {
      resolve(false)
      return
    }
    child.once('error', () => {
      if (settled) return
      settled = true
      resolve(false)
    })
    child.once('spawn', () => {
      if (settled) return
      settled = true
      child.unref()
      resolve(true)
    })
  })
}

export interface LaunchTranscriptViewerOptions {
  dwarfName: string
  transcriptPath: string
  viewerScriptPath: string
  /** Injected for tests; defaults to node:child_process.spawn. */
  spawn?: SpawnFn
}

/**
 * Opens a real terminal window tailing `transcriptPath` live: wt.exe first
 * (a titled tab, so the desktop doesn't fill up with separate windows),
 * falling back to a standalone powershell.exe window when Windows Terminal
 * isn't installed.
 */
export async function launchTranscriptViewer(
  options: LaunchTranscriptViewerOptions
): Promise<boolean> {
  const spawnFn = options.spawn ?? realSpawn
  const wtArgs = buildWtArgs(options.dwarfName, options.viewerScriptPath, options.transcriptPath)
  if (await trySpawn(spawnFn, 'wt.exe', wtArgs)) return true

  const fallbackArgs = buildFallbackArgs(
    options.dwarfName,
    options.viewerScriptPath,
    options.transcriptPath
  )
  return trySpawn(spawnFn, 'powershell.exe', fallbackArgs)
}
