import { join } from 'node:path'
import type { HookToggleResult } from '../hooks/hookChannel'
import { OPENCODE_PUSH_ROUTE } from '../hooks/hookCommand'
import type { HookFsLike } from '../hooks/hookFs'
import type { HookListener } from '../hooks/hookListener'
import {
  buildOpenCodePluginFile,
  installOpenCodePlugin,
  openCodePluginSource,
  uninstallOpenCodePlugin
} from './openCodePluginInstaller'

/**
 * Marker file under Electron's userData directory recording that the person
 * opted in to the OpenCode permission plugin. Presence is the opt-in, exactly
 * like `HOOKS_ENABLED_MARKER` — off until this file exists.
 */
export const OPENCODE_PLUGIN_ENABLED_MARKER = 'opencode-plugin-enabled.marker'

/**
 * A second marker line meaning "the plugin directory is ours": recorded at
 * the first install, because on every later launch the directory already
 * exists and that fact alone can no longer say who made it.
 */
const CREATED_DIR_LINE = 'created-plugin-dir'

export interface OpenCodePluginChannelOptions {
  fs: HookFsLike
  /**
   * OpenCode's global plugin directory, from `openCodeGlobalPluginDir`, or
   * null when this machine's configuration names none this app can write to.
   */
  pluginDir: string | null
  userDataDir: string
  /** The listener shared with the Claude hook channel; this opens only the OpenCode route. */
  listener: HookListener
  source?: string
  log?: (message: string) => void
  warn?: (message: string, error?: unknown) => void
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The OpenCode permission relay, as one consent (#588 T6).
 *
 * Mirrors `HookChannel` step for step, because it is the same kind of act —
 * writing into configuration the person owns — and the same order keeps it
 * honest: open the route first (the failure most likely to happen), write the
 * plugin second, remember the choice only once both succeeded, and walk
 * everything back on any failure, so the switch in Settings and reality never
 * disagree.
 *
 * Independent of the Claude channel in both directions (F5): it opens only
 * its own route on the shared listener, needs no curl (the plugin posts with
 * OpenCode's own `fetch`), and turning it off leaves Claude's route exactly
 * as it was.
 */
export class OpenCodePluginChannel {
  private readonly options: OpenCodePluginChannelOptions
  private readonly markerPath: string

  constructor(options: OpenCodePluginChannelOptions) {
    this.options = options
    this.markerPath = join(options.userDataDir, OPENCODE_PLUGIN_ENABLED_MARKER)
  }

  /** Whether the OpenCode route is being served right now. */
  isActive(): boolean {
    return this.options.listener.isOpen('opencode')
  }

  async isOptedIn(): Promise<boolean> {
    return this.options.fs.exists(this.markerPath)
  }

  /** Route open, plugin written, choice remembered — or an explained refusal. */
  async enable(): Promise<HookToggleResult> {
    return this.turnOn({ remember: true })
  }

  /**
   * Bring the relay back at launch if the person had opted in; null when they
   * never did. Rewrites the plugin, so a changed port or a file removed while
   * the app was closed is put right. A failure keeps the marker, for the
   * reason `HookChannel.restore` gives.
   */
  async restore(): Promise<HookToggleResult | null> {
    if (!(await this.isOptedIn())) return null
    const result = await this.turnOn({ remember: false })
    if (!result.enabled) {
      this.options.warn?.(
        `[opencode] Permission relay could not start: ${result.error ?? 'unknown'}`
      )
    }
    return result
  }

  private async turnOn(options: { remember: boolean }): Promise<HookToggleResult> {
    if (this.isActive()) return { enabled: true }
    const pluginDir = this.options.pluginDir
    if (pluginDir === null) {
      return {
        enabled: false,
        error:
          "OpenCode's configuration directory could not be located: XDG_CONFIG_HOME is set " +
          'to a relative path, which OpenCode resolves differently for every session.'
      }
    }

    const listener = this.options.listener
    const opened = await listener.open('opencode')
    if (!opened.opened) return { enabled: false, error: opened.error }

    let content: string
    try {
      content = buildOpenCodePluginFile({
        source: this.options.source ?? openCodePluginSource,
        pushUrl: `http://127.0.0.1:${listener.port}${OPENCODE_PUSH_ROUTE}`,
        token: opened.token
      })
    } catch (error) {
      await listener.close('opencode')
      return { enabled: false, error: messageOf(error) }
    }

    const report = await installOpenCodePlugin({ fs: this.options.fs, pluginDir, content })
    if (report.error !== undefined) {
      await listener.close('opencode')
      return { enabled: false, error: report.error }
    }

    if (options.remember) {
      try {
        await this.options.fs.ensureDir(this.options.userDataDir)
        const lines = [
          OPENCODE_PLUGIN_ENABLED_MARKER,
          ...(report.createdDir ? [CREATED_DIR_LINE] : [])
        ]
        await this.options.fs.writeText(this.markerPath, `${lines.join('\n')}\n`)
      } catch (error) {
        this.options.warn?.('[opencode] Could not persist the permission-relay choice', error)
      }
    }
    this.options.log?.(`[opencode] Permission relay installed at ${report.path}`)
    return { enabled: true }
  }

  /** Route closed, exactly what was written removed, choice forgotten. */
  async disable(): Promise<void> {
    await this.options.listener.close('opencode')
    const pluginDir = this.options.pluginDir
    if (pluginDir !== null) {
      const marker = (await this.options.fs.readText(this.markerPath)) ?? ''
      const report = await uninstallOpenCodePlugin({
        fs: this.options.fs,
        pluginDir,
        removeDir: marker.split('\n').includes(CREATED_DIR_LINE)
      })
      if (report.error !== undefined) {
        this.options.warn?.(`[opencode] Could not remove ${report.path}: ${report.error}`)
      }
    }
    try {
      await this.options.fs.remove(this.markerPath)
    } catch (error) {
      this.options.warn?.('[opencode] Could not clear the permission-relay choice', error)
    }
  }

  /**
   * Release the route at quit without touching OpenCode's configuration. The
   * plugin's push then simply fails to connect, which it already treats as an
   * ordinary, silent outcome.
   */
  async shutdown(): Promise<void> {
    await this.options.listener.close('opencode')
  }
}
