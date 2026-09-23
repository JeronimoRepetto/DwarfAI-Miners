import { join } from 'node:path'
import type { HookServerLike } from './hookChannel'
import type { HookFsLike } from './hookFs'
import type { HookEvent } from './hookPayload'
import { HookServer, type HookRouteName, type HookServerOptions } from './hookServer'
import { HOOK_TOKEN_FILE, loadOrCreateHookToken } from './hookToken'
import type { OpenCodePermissionPush } from '../opencodePermissions/permissionPushPayload'

export interface HookListenerOptions {
  fs: HookFsLike
  /** Electron's userData directory: the per-install token lives here. */
  userDataDir: string
  port: number
  onEvent: (event: HookEvent) => void
  onOpenCodePush?: (push: OpenCodePermissionPush) => void
  createServer?: (options: HookServerOptions) => HookServerLike
  log?: (message: string) => void
  warn?: (message: string, error?: unknown) => void
}

export type HookRouteOpenResult = { opened: true; token: string } | { opened: false; error: string }

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The one loopback listener, shared by two consents that must never depend on
 * each other (#588 T6, F5).
 *
 * Before this, the Claude hook channel owned the listener outright, so an
 * OpenCode permission card could only ever appear for someone who had also
 * switched on Claude's instant updates — one provider made a prerequisite for
 * another, which this project does not allow. Now each channel opens its own
 * route: the port is bound while at least one route is open and released with
 * the last, and the server answers a closed route with a plain 404, so a
 * Claude-only user's listener serves Claude alone and an OpenCode-only user's
 * serves OpenCode alone.
 *
 * One token for both routes, deliberately: it is the same per-install secret
 * whether it ends up in a Claude hook command or in the OpenCode plugin file.
 * That coupling is stated to the person where they consent to the plugin
 * (Settings' OpenCode section), not only here.
 */
export class HookListener {
  private readonly options: HookListenerOptions
  private readonly tokenPath: string
  private readonly openRoutes = new Set<HookRouteName>()
  private server: HookServerLike | null = null
  private token: string | null = null
  /** Serialises opens and closes, so two consents clicked together never race a bind. */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(options: HookListenerOptions) {
    this.options = options
    this.tokenPath = join(options.userDataDir, HOOK_TOKEN_FILE)
  }

  /** The configured port, which is what either channel bakes into what it installs. */
  get port(): number {
    return this.options.port
  }

  isOpen(route: HookRouteName): boolean {
    return this.openRoutes.has(route)
  }

  isListening(): boolean {
    return this.server !== null
  }

  /**
   * Serve one route, binding the port first if nothing else holds it.
   *
   * Returns an explained refusal rather than throwing, because both callers
   * are consent switches that have to put themselves back and say why. A
   * route is only marked open once the listener is actually up, so a failed
   * bind can never leave a route claiming to be served.
   */
  async open(route: HookRouteName): Promise<HookRouteOpenResult> {
    return this.serialise(async () => {
      let token: string
      try {
        token = await loadOrCreateHookToken({ fs: this.options.fs, path: this.tokenPath })
      } catch (error) {
        return { opened: false, error: messageOf(error) }
      }
      if (this.server === null) {
        const failure = await this.startServer(token)
        if (failure !== null) return { opened: false, error: failure }
      }
      this.openRoutes.add(route)
      return { opened: true, token: this.token ?? token }
    })
  }

  /** Stop serving one route; the port is released with the last open route. */
  async close(route: HookRouteName): Promise<void> {
    await this.serialise(async () => {
      this.openRoutes.delete(route)
      if (this.openRoutes.size === 0) await this.stopServer()
    })
  }

  /** Release the port at quit. What each channel installed stays installed. */
  async shutdown(): Promise<void> {
    await this.serialise(async () => {
      this.openRoutes.clear()
      await this.stopServer()
    })
  }

  private serialise<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work)
    this.queue = next.catch(() => undefined)
    return next
  }

  private async startServer(token: string): Promise<string | null> {
    // The same secret on every route: embedded in whatever each channel
    // installs, and required by the listener those installs post to.
    const server = (this.options.createServer ?? ((o) => new HookServer(o)))({
      port: this.options.port,
      token,
      onEvent: this.options.onEvent,
      onOpenCodePush: this.options.onOpenCodePush,
      isRouteOpen: (route) => this.openRoutes.has(route),
      log: this.options.log
    })
    try {
      await server.start()
    } catch (error) {
      return `Port ${this.options.port} could not be opened: ${messageOf(error)}`
    }
    this.server = server
    this.token = token
    return null
  }

  private async stopServer(): Promise<void> {
    const server = this.server
    this.server = null
    this.token = null
    if (server === null) return
    try {
      await server.stop()
    } catch (error) {
      this.options.warn?.('[hooks] Listener did not stop cleanly', error)
    }
  }
}
