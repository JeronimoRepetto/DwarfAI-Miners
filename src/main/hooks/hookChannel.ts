import { join } from 'node:path'
import { buildHookCommand, curlBinaryFor } from './hookCommand'
import type { HookFsLike } from './hookFs'
import { installClaudeHooks, uninstallClaudeHooks, type HookInstallReport } from './hookInstaller'
import type { HookEvent } from './hookPayload'
import { HookServer, type HookServerOptions } from './hookServer'
import { HOOK_TOKEN_FILE, loadOrCreateHookToken } from './hookToken'

/**
 * Marker file under Electron's userData directory recording that the user
 * opted in. Presence is the whole state, exactly like the autostart marker —
 * the feature is off until this file exists.
 */
export const HOOKS_ENABLED_MARKER = 'hooks-enabled.marker'

/** The tray label for the opt-in. Named for what it does, not how it does it. */
export const HOOKS_MENU_LABEL = 'Instant updates (Claude hooks)'

/** The part of HookServer this orchestrator uses; a fake stands in for tests. */
export interface HookServerLike {
  start(): Promise<void>
  stop(): Promise<void>
  readonly port: number
}

export interface HookToggleResult {
  enabled: boolean
  /** Why it could not be turned on, phrased for a tray warning. */
  error?: string
}

export interface HookChannelOptions {
  fs: HookFsLike
  /** Absolute Claude config roots, already home-expanded. */
  roots: readonly string[]
  /** Electron's userData directory: token and opt-in marker live here. */
  userDataDir: string
  port: number
  platform: NodeJS.Platform
  onEvent: (event: HookEvent) => void
  createServer?: (options: HookServerOptions) => HookServerLike
  curlAvailable?: () => Promise<boolean>
  log?: (message: string) => void
  warn?: (message: string, error?: unknown) => void
}

/**
 * Whether the relay binary the hook command names actually exists here.
 *
 * Windows 10 1803+ ships curl.exe in System32 and every supported macOS and
 * Linux has one in the usual place, but "usually present" is not "present":
 * installing a hook that cannot run would leave the user with a checkbox that
 * looks on and does nothing.
 */
export async function isCurlAvailable(
  fs: HookFsLike,
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>
): Promise<boolean> {
  const candidates =
    platform === 'win32'
      ? [join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'curl.exe')]
      : ['/usr/bin/curl', '/bin/curl', '/opt/homebrew/bin/curl']
  for (const candidate of candidates) {
    if (await fs.exists(candidate)) return true
  }
  return false
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The opt-in push channel, as one switch.
 *
 * Enabling it is the only thing in this app that writes to a file the user
 * owns, so the order is deliberate: bind the port first (the failure most
 * likely to happen), install the hooks second, and only remember the choice
 * once both succeeded. Any failure walks the whole thing back, so the tray
 * checkbox and reality never disagree.
 */
export class HookChannel {
  private readonly options: HookChannelOptions
  private readonly markerPath: string
  private readonly tokenPath: string
  private server: HookServerLike | null = null

  constructor(options: HookChannelOptions) {
    this.options = options
    this.markerPath = join(options.userDataDir, HOOKS_ENABLED_MARKER)
    this.tokenPath = join(options.userDataDir, HOOK_TOKEN_FILE)
  }

  /** Whether the listener is up right now, which is what the tray should show. */
  isActive(): boolean {
    return this.server !== null
  }

  /** Whether the user opted in, regardless of whether the listener came up. */
  async isOptedIn(): Promise<boolean> {
    return this.options.fs.exists(this.markerPath)
  }

  /**
   * Turn the channel on: listener up, hooks written, choice remembered.
   *
   * Returns an explained refusal rather than throwing, because its one caller
   * is a tray checkbox that has to put itself back and say why.
   */
  async enable(): Promise<HookToggleResult> {
    return this.turnOn({ remember: true })
  }

  /**
   * Bring the channel back up at launch if the user had opted in.
   *
   * Returns null when they never did. A failure here keeps the marker: a port
   * held by a leftover instance is a temporary condition, and silently
   * cancelling a deliberate choice would be worse than showing it as off.
   */
  async restore(): Promise<HookToggleResult | null> {
    if (!(await this.isOptedIn())) return null
    const result = await this.turnOn({ remember: false })
    if (!result.enabled) {
      this.options.warn?.(`[hooks] Instant updates could not start: ${result.error ?? 'unknown'}`)
    }
    return result
  }

  private async turnOn(options: { remember: boolean }): Promise<HookToggleResult> {
    if (this.server !== null) return { enabled: true }

    const curlAvailable =
      this.options.curlAvailable ??
      (() => isCurlAvailable(this.options.fs, this.options.platform, process.env))
    if (!(await curlAvailable())) {
      return {
        enabled: false,
        error:
          `Instant updates need ${curlBinaryFor(this.options.platform)}, ` +
          'which was not found on this machine.'
      }
    }

    let token: string
    let command: string
    try {
      token = await loadOrCreateHookToken({ fs: this.options.fs, path: this.tokenPath })
      command = buildHookCommand({
        port: this.options.port,
        token,
        platform: this.options.platform
      })
    } catch (error) {
      return { enabled: false, error: messageOf(error) }
    }

    // The same secret on both sides: embedded in the command Claude Code runs,
    // and required by the listener that command posts to.
    const server = (this.options.createServer ?? ((o) => new HookServer(o)))({
      port: this.options.port,
      token,
      onEvent: this.options.onEvent,
      log: this.options.log
    })
    const started = await this.startServer(server)
    if (started !== null) return { enabled: false, error: started }
    this.server = server

    const installed = await this.installInto(command)
    if (installed !== null) {
      await this.stopServer()
      return { enabled: false, error: installed }
    }

    if (options.remember) {
      try {
        await this.options.fs.ensureDir(this.options.userDataDir)
        await this.options.fs.writeText(this.markerPath, `${HOOKS_ENABLED_MARKER}\n`)
      } catch (error) {
        this.options.warn?.('[hooks] Could not persist the instant-updates choice', error)
      }
    }
    this.options.log?.(`[hooks] Instant updates listening on 127.0.0.1:${this.options.port}`)
    return { enabled: true }
  }

  private async startServer(server: HookServerLike): Promise<string | null> {
    try {
      await server.start()
      return null
    } catch (error) {
      return `Port ${this.options.port} could not be opened: ${messageOf(error)}`
    }
  }

  /** Write the hooks; null on success, an explained message when no root took them. */
  private async installInto(command: string): Promise<string | null> {
    let reports: HookInstallReport[]
    try {
      reports = await installClaudeHooks({
        fs: this.options.fs,
        roots: this.options.roots,
        command
      })
    } catch (error) {
      return messageOf(error)
    }
    this.warnAboutFailures(reports)
    if (reports.length === 0) {
      return 'No Claude configuration directory was found on this machine.'
    }
    const failures = reports.filter((report) => report.error !== undefined)
    if (failures.length === reports.length) {
      return failures[0]?.error ?? 'The Claude hooks could not be installed.'
    }
    return null
  }

  private warnAboutFailures(reports: readonly HookInstallReport[]): void {
    for (const report of reports) {
      if (report.error === undefined) continue
      this.options.warn?.(`[hooks] Left ${report.settingsPath} untouched: ${report.error}`)
    }
  }

  /** Turn the channel off: listener down, hooks removed, choice forgotten. */
  async disable(): Promise<void> {
    await this.stopServer()
    try {
      this.warnAboutFailures(
        await uninstallClaudeHooks({ fs: this.options.fs, roots: this.options.roots })
      )
    } catch (error) {
      this.options.warn?.('[hooks] Could not remove the Claude hooks', error)
    }
    try {
      await this.options.fs.remove(this.markerPath)
    } catch (error) {
      this.options.warn?.('[hooks] Could not clear the instant-updates choice', error)
    }
  }

  /**
   * Release the port at quit without touching the user's config: the installed
   * hooks and the opt-in are what bring the channel back on the next launch.
   * A hook that fires meanwhile just fails to connect, which Claude Code
   * treats as a non-blocking error.
   */
  async shutdown(): Promise<void> {
    await this.stopServer()
  }

  private async stopServer(): Promise<void> {
    const server = this.server
    this.server = null
    if (server === null) return
    try {
      await server.stop()
    } catch (error) {
      this.options.warn?.('[hooks] Listener did not stop cleanly', error)
    }
  }
}

/** The part of HookChannel a tray checkbox drives. */
export interface HookToggleTarget {
  isActive(): boolean
  enable(): Promise<HookToggleResult>
  disable(): Promise<void>
}

/**
 * Turn one tray-checkbox click into the state that checkbox must end up in.
 *
 * Electron has already flipped the item visually by the time the click handler
 * runs, so a request that cannot be honoured has to be reflected back — the
 * checkbox must never claim the channel is on while nothing is listening. The
 * reason travels with it so the caller can say what went wrong.
 */
export async function applyHookToggle(
  target: HookToggleTarget,
  wanted: boolean
): Promise<{ checked: boolean; warning?: string }> {
  try {
    if (!wanted) {
      await target.disable()
      return { checked: false }
    }
    const result = await target.enable()
    return result.enabled ? { checked: true } : { checked: false, warning: result.error }
  } catch (error) {
    return { checked: target.isActive(), warning: messageOf(error) }
  }
}
