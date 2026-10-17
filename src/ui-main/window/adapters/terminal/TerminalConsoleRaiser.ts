// `TerminalConsoleRaiser` (ISSUE-170; the `ConsoleRaiser` port behind 16 §4.14
// `NativeActions.raiseConsole`; ADR-031 items 1, 2, 4; UC-036; 05 R17): UI main executes the console
// target the Host resolved, right after the person's click, which holds the foreground right.
//
// - `focus-terminal`: brings the terminal window hosting that process to the front (the Windows
//   console/terminal-host walk of focus/windowsFocus.ts, the macOS ancestor walk of
//   focus/posixFocus.ts; Linux has no portable raise and answers `failed`). `raised` when it came
//   forward.
// - `log`: opens the OS terminal running the target's command — the viewer on the versioned-copy
//   executable with the token file's path — through consoleLaunch.ts's chain: each candidate is an
//   argv array spawned with `shell: false`, detached, its stdio ignored (the terminal brings its
//   own), in the command's `cwd`, with ELECTRON_RUN_AS_NODE=1 added to the environment. The token is
//   never read here: only its file's path crosses (ADR-003 item 12). `raised` as soon as one
//   candidate started; `failed` when none did (FM-054: the person can open it again).
// - `attach` is not built in v1 (S-031-1 failed; S-031-3 not passed): `failed`, never run.
// - A target without what its mode needs is `failed`. Nothing here logs a path or a value.
import { spawn as nodeSpawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type { ConsoleTarget } from '@dwarfai/contracts'
import type { ConsoleRaiser } from '../../ports/nativeActions'
import { consoleLaunchChain, darwinLauncherPath, type TerminalLaunch } from './consoleLaunch'
import { createDarwinFocus, createUnsupportedFocus } from './focus/posixFocus'
import { focusPid as windowsFocusPid } from './focus/windowsFocus'

/** Minimal shape of node:child_process's ChildProcess, so tests never start a real process. */
export interface SpawnedProcess {
  once(event: 'error' | 'spawn', listener: (error?: Error) => void): void
  unref(): void
}

/** What a candidate is spawned with: always an argv array, never a shell. */
export interface SpawnOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  shell: false
  detached: true
  stdio: 'ignore'
  windowsHide: false
}

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => SpawnedProcess

/** Where and how the macOS launcher file is written, so tests touch no disk. */
export interface LauncherFiles {
  directory(): string
  /** Sixteen lowercase hex digits, the launcher's own name. */
  randomHex(): string
  /** Creates the file exclusively, readable by this user only; rejects if it already exists. */
  write(path: string, content: string): Promise<void>
  remove(path: string): Promise<void>
}

export interface TerminalConsoleRaiserDeps {
  platform?: NodeJS.Platform
  /** The environment the terminal starts from (UI main's own). */
  env?: NodeJS.ProcessEnv
  spawn?: SpawnFn
  /** Raises the terminal window hosting `pid`; true when it came forward. */
  focus?: (pid: number) => Promise<boolean>
  launcherFiles?: LauncherFiles
  /** The candidate chain; defaults to consoleLaunch.ts's for the platform (the OS lane passes a stub terminal). */
  chain?: typeof consoleLaunchChain
}

const realLauncherFiles: LauncherFiles = {
  directory: () => tmpdir(),
  randomHex: () => randomBytes(8).toString('hex'),
  write: (path, content) => writeFile(path, content, { flag: 'wx', mode: 0o600 }),
  remove: (path) => rm(path, { force: true })
}

function realSpawn(command: string, args: string[], options: SpawnOptions): SpawnedProcess {
  return nodeSpawn(command, args, options)
}

function focusFor(platform: NodeJS.Platform): (pid: number) => Promise<boolean> {
  if (platform === 'win32') return (pid) => windowsFocusPid(pid)
  if (platform === 'darwin') return createDarwinFocus()
  return createUnsupportedFocus()
}

export class TerminalConsoleRaiser implements ConsoleRaiser {
  private readonly platform: NodeJS.Platform
  private readonly env: NodeJS.ProcessEnv
  private readonly spawn: SpawnFn
  private readonly focus: (pid: number) => Promise<boolean>
  private readonly files: LauncherFiles
  private readonly chain: typeof consoleLaunchChain

  constructor(deps: TerminalConsoleRaiserDeps = {}) {
    this.platform = deps.platform ?? process.platform
    this.env = deps.env ?? process.env
    this.spawn = deps.spawn ?? realSpawn
    this.focus = deps.focus ?? focusFor(this.platform)
    this.files = deps.launcherFiles ?? realLauncherFiles
    this.chain = deps.chain ?? consoleLaunchChain
  }

  async raise(target: ConsoleTarget): Promise<'raised' | 'failed'> {
    if (target.mode === 'focus-terminal') {
      if (target.focus === undefined) return 'failed'
      try {
        return (await this.focus(target.focus.pid)) ? 'raised' : 'failed'
      } catch {
        return 'failed'
      }
    }
    if (target.mode !== 'log' || target.command === undefined) return 'failed'
    let chain: TerminalLaunch[]
    try {
      chain = this.chain({
        platform: this.platform,
        command: target.command,
        ...(this.platform === 'darwin'
          ? { launcherPath: darwinLauncherPath(this.files.directory(), this.files.randomHex()) }
          : {})
      })
    } catch {
      return 'failed'
    }
    for (const candidate of chain) {
      if (candidate.file !== undefined) {
        try {
          await this.files.write(candidate.file.path, candidate.file.content)
        } catch {
          continue
        }
      }
      if (await this.started(candidate, target.command.cwd)) return 'raised'
      // It never started, so nothing will run the launcher and remove it.
      if (candidate.file !== undefined) {
        await this.files.remove(candidate.file.path).catch(() => undefined)
      }
    }
    return 'failed'
  }

  /** True once the candidate actually started (the `spawn` event), false on any error. */
  private started(candidate: TerminalLaunch, cwd: string): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false
      let child: SpawnedProcess
      try {
        child = this.spawn(candidate.command, [...candidate.args], {
          cwd,
          env: { ...this.env, ...candidate.env },
          shell: false,
          detached: true,
          stdio: 'ignore',
          windowsHide: false
        })
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
}
