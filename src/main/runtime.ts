import { homedir } from 'node:os'
import { join } from 'node:path'
import { NodeFs, type FsLike } from './adapters/fsLike'
import { NodeSqlite, type SqliteLike } from './adapters/sqliteLike'
import type { AppConfig } from './config'
import type {
  DwarfActivation,
  DwarfKickRequest,
  DwarfKickResult,
  DwarfTextRequest,
  DwarfTextResult,
  Mine
} from '../shared/contracts'
import { MAX_DWARF_TEXT_CHARS } from '../shared/contracts'
import { DwarfLifecycleTracker } from './domain/lifecycle'
import { createPlatformAdapters, type PlatformAdapters } from './platform/platformAdapters'
import { Poller } from './poller'
import { ClaudeProvider } from './providers/claude/claudeProvider'
import { CodexProvider } from './providers/codex/codexProvider'
import type { Provider } from './providers/provider'
import type { ViewerPathOptions } from './terminalLauncher'
import type { TextDeliveryPort, TextDeliveryTarget } from './textDelivery/port'
import { resolveKickDelivery, resolveTextDelivery, stampTextDelivery } from './textDelivery/resolve'
import { TierService } from './tier/tierService'

const FEED_LIMIT = 12

/** Refusals that never reach the delivery port, phrased for the panel. */
const NO_SUCH_DWARF = 'That dwarf has left the mine.'
const NO_CHANNEL = "This session type can't receive messages yet."
const EMPTY_MESSAGE = 'Type a message first.'
const NO_KICK_CHANNEL = "This session type can't be canceled yet."

/**
 * Fixed instructions Kick delivers over the relay tier. Never user text, so
 * unlike sendDwarfText's payload there is nothing here to keep out of the log
 * beyond what the existing terse verdict line already omits.
 */
const CANCEL_INSTRUCTION =
  'The user asks you to STOP your current work now. Interrupt what you are doing, ' +
  'leave things in a safe state, and wait for further instructions.'
/** Addressed at a specific worker through its foreman; resolveKickDelivery's '[cancel agent X] ' prefix already names which one. */
const CANCEL_WORKER_INSTRUCTION =
  'Stop that agent now. Interrupt its work, leave things in a safe state, and wait for further instructions.'

/** Expand only a leading home shorthand; other paths are passed through. */
export function expandHomePath(path: string, home: string = homedir()): string {
  if (path === '~') return home
  if (path.startsWith('~/') || path.startsWith('~\\')) {
    return join(home, path.slice(2))
  }
  return path
}

export interface RuntimeOptions {
  config: AppConfig
  onMinesUpdated: (mines: Mine[]) => void
  home?: string
  fs?: FsLike
  /** Read-only SQLite access for the Codex registry; injected for tests. */
  sqlite?: SqliteLike
  providers?: Provider[]
  focus?: (pid: number) => Promise<boolean>
  /** Electron packaging info, used only to resolve the transcript-viewer script path. */
  appPaths?: ViewerPathOptions
  /** Opens a terminal tailing a dwarf's transcript; injected for tests. */
  launchTerminal?: (dwarfName: string, transcriptPath: string) => Promise<boolean>
  /** Writes a typed message into a live session; injected for tests. */
  textDelivery?: TextDeliveryPort
  /** Every per-OS adapter, already selected; injected for tests. */
  platformAdapters?: PlatformAdapters
  /** Injected for deterministic lifecycle-grace tests; defaults to Date.now. */
  now?: () => number
}

/**
 * Runtime bridge between disk-backed providers and Electron IPC. Keeping it
 * independent from Electron makes its lifecycle and activation behavior testable.
 */
export class AgentRuntime {
  private readonly providers: Provider[]
  private readonly poller: Poller
  private readonly focus: (pid: number) => Promise<boolean>
  private readonly launchTerminal: (dwarfName: string, transcriptPath: string) => Promise<boolean>
  private readonly textDelivery: TextDeliveryPort
  private mines: Mine[] = []

  constructor(options: RuntimeOptions) {
    const home = options.home ?? homedir()
    const fs = options.fs ?? new NodeFs()
    const appPaths: ViewerPathOptions = options.appPaths ?? {
      isPackaged: false,
      resourcesPath: process.resourcesPath ?? '',
      appPath: process.cwd()
    }
    // The one place the running operating system is consulted: everything
    // below depends on ports, never on process.platform.
    const platform =
      options.platformAdapters ??
      createPlatformAdapters({
        home,
        appPaths,
        relayModel: options.config.sendTextRelayModel,
        relayTimeoutMs: options.config.sendTextTimeoutS * 1_000
      })

    this.providers = options.providers ?? [
      new ClaudeProvider({
        fs,
        roots: options.config.claudeConfigDirs.map((path) => expandHomePath(path, home))
      }),
      new CodexProvider({
        isCodexProcessRunning: () => platform.processProbe.isCodexProcessRunning(),
        fs,
        sessionsRoot: expandHomePath(options.config.codexSessionsRoot, home),
        livenessWindowS: options.config.codexLivenessWindowS,
        scanDays: options.config.codexScanDays,
        idleRetentionS: options.config.codexIdleRetentionS,
        heartbeatWindowS: options.config.codexHeartbeatWindowS,
        sqlite: options.sqlite ?? new NodeSqlite(),
        stateDbPath: expandHomePath(options.config.codexStateDb, home),
        logsDbPath: expandHomePath(options.config.codexLogsDb, home)
      })
    ]
    this.focus = options.focus ?? ((pid) => platform.focusPid(pid))
    this.launchTerminal =
      options.launchTerminal ??
      ((dwarfName, transcriptPath) => platform.launchTranscriptViewer(dwarfName, transcriptPath))
    this.textDelivery = options.textDelivery ?? platform.textDelivery

    const tiers = new TierService({
      fs,
      thresholds: options.config.tierThresholds,
      ttlS: options.config.tierCacheTtlS
    })
    const lifecycle = new DwarfLifecycleTracker({
      graceMs: options.config.dwarfLeaveGraceS * 1_000,
      now: options.now
    })
    this.poller = new Poller({
      providers: this.providers,
      intervalMs: options.config.pollIntervalMs,
      tierOf: (path) => tiers.tierOf(path),
      onUpdate: (mines) => {
        // The panel decides which actions to offer per dwarf, so the resolved
        // delivery channel travels with the snapshot instead of costing an
        // extra IPC round trip per sprite.
        const published = stampTextDelivery(lifecycle.apply(mines), (dwarfId) =>
          this.deliveryTargetOf(dwarfId)
        )
        this.mines = published
        options.onMinesUpdated(published)
      },
      logError: (message, error) => console.warn(message, error)
    })
  }

  start(): void {
    this.poller.start()
  }

  stop(): void {
    this.poller.stop()
  }

  /** Execute a deterministic scan for IPC/tests without starting an interval. */
  async refresh(): Promise<void> {
    await this.poller.tick()
  }

  getMines(): Mine[] {
    return this.mines
  }

  /**
   * Ask whichever provider owns `dwarfId` how a message could reach it. A
   * provider that predates the capability surface (or does not implement it)
   * simply reports no channel.
   *
   * A 'terminal' target is dropped on platforms whose delivery port cannot
   * type into a console (macOS until its osascript path is verified, Linux
   * always). Providers answer from what the SESSION offers, which is a fact
   * about the session, not about this machine; intersecting the two here is
   * what makes the panel show a disabled button with a reason instead of a
   * Send that quietly types nowhere.
   */
  private deliveryTargetOf(dwarfId: string): TextDeliveryTarget | null {
    const consoleSupported = this.textDelivery.supportsConsoleInput !== false
    for (const provider of this.providers) {
      const target = provider.textDelivery?.(dwarfId)
      if (target === undefined || target === null) continue
      if (target.kind === 'terminal' && !consoleSupported) return null
      return target
    }
    return null
  }

  /**
   * Hand a typed message to a dwarf's live session.
   *
   * Refusals are explicit and cheap (unknown dwarf, a session already leaving,
   * an empty message, no channel at all) so the panel can explain itself
   * instead of leaving the user wondering whether the text landed. Nothing
   * here logs the message: only its length, the channel and the verdict.
   */
  async sendDwarfText(request: DwarfTextRequest): Promise<DwarfTextResult> {
    const dwarf = this.mines
      .flatMap((mine) => mine.dwarfs)
      .find((item) => item.id === request.dwarfId)
    // A 'leaving' dwarf's agent has already finished: its pid is stale (and
    // could have been reused) and its session name no longer resolves, so
    // there is nothing safe to write to.
    if (dwarf === undefined || dwarf.status === 'leaving') {
      return { delivered: false, via: 'none', error: NO_SUCH_DWARF }
    }

    const text = request.text.trim().slice(0, MAX_DWARF_TEXT_CHARS)
    if (text === '') return { delivered: false, via: 'none', error: EMPTY_MESSAGE }

    const resolved = resolveTextDelivery(request.dwarfId, (id) => this.deliveryTargetOf(id))
    if (resolved === null) return { delivered: false, via: 'none', error: NO_CHANNEL }

    const payload = `${resolved.prefix}${text}`
    try {
      const outcome =
        resolved.endpoint.kind === 'terminal'
          ? await this.textDelivery.sendToConsole({
              pid: resolved.endpoint.pid,
              text: payload,
              pressEnter: request.pressEnter
            })
          : await this.textDelivery.relayToClaudeSession({
              sessionName: resolved.endpoint.sessionName,
              text: payload
            })
      console.log(
        `[runtime] Message to ${request.dwarfId} via ${resolved.channel}: ` +
          `${outcome.delivered ? 'delivered' : 'failed'} (${payload.length} chars)`
      )
      return outcome.delivered
        ? { delivered: true, via: resolved.channel }
        : { delivered: false, via: resolved.channel, error: outcome.error }
    } catch (error) {
      console.warn(`[runtime] Delivery to ${request.dwarfId} threw`, error)
      return {
        delivered: false,
        via: resolved.channel,
        error: 'The message could not be delivered.'
      }
    }
  }

  /**
   * Cancel a dwarf's current work (Kick). Mirrors sendDwarfText's refusals and
   * channel routing, but never carries user text: a terminal-hosted session
   * gets a raw interrupt keystroke (ESC), and a relay tier gets one of the two
   * fixed instructions above — this session's own turn, or (through its
   * foreman) a named worker's.
   */
  async kickDwarf(request: DwarfKickRequest): Promise<DwarfKickResult> {
    const dwarf = this.mines
      .flatMap((mine) => mine.dwarfs)
      .find((item) => item.id === request.dwarfId)
    // Same reasoning as sendDwarfText: a 'leaving' dwarf's agent has already
    // finished, so its retained pid/session are stale and there is nothing
    // safe to interrupt.
    if (dwarf === undefined || dwarf.status === 'leaving') {
      return { delivered: false, via: 'none', error: NO_SUCH_DWARF }
    }

    const resolved = resolveKickDelivery(request.dwarfId, (id) => this.deliveryTargetOf(id))
    if (resolved === null) return { delivered: false, via: 'none', error: NO_KICK_CHANNEL }

    try {
      const outcome =
        resolved.endpoint.kind === 'terminal'
          ? await this.textDelivery.sendInterrupt({ pid: resolved.endpoint.pid })
          : await this.textDelivery.relayToClaudeSession({
              sessionName: resolved.endpoint.sessionName,
              text:
                resolved.prefix === ''
                  ? CANCEL_INSTRUCTION
                  : `${resolved.prefix}${CANCEL_WORKER_INSTRUCTION}`
            })
      console.log(
        `[runtime] Kick for ${request.dwarfId} via ${resolved.channel}: ` +
          `${outcome.delivered ? 'delivered' : 'failed'}`
      )
      return outcome.delivered
        ? { delivered: true, via: resolved.channel }
        : { delivered: false, via: resolved.channel, error: outcome.error }
    } catch (error) {
      console.warn(`[runtime] Kick for ${request.dwarfId} threw`, error)
      return {
        delivered: false,
        via: resolved.channel,
        error: 'The kick could not be delivered.'
      }
    }
  }

  async activateDwarf(dwarfId: string): Promise<DwarfActivation> {
    const dwarf = this.mines.flatMap((mine) => mine.dwarfs).find((item) => item.id === dwarfId)
    if (dwarf === undefined) return { focused: false, openedTerminal: false, feed: [] }

    // A 'leaving' dwarf's agent has already finished/disappeared: its
    // retained pid is stale, and on a long-running machine could even have
    // been reused by an unrelated process. There is nothing to focus, so
    // skip straight to the terminal/feed fallbacks below (which still read
    // from disk and work fine for as long as the dwarf stays in its grace
    // period) instead of risking a focus on the wrong window.
    if (dwarf.pid !== undefined && dwarf.status !== 'leaving') {
      try {
        if (await this.focus(dwarf.pid)) {
          return { focused: true, openedTerminal: false, feed: [] }
        }
      } catch (error) {
        console.warn(`[runtime] Failed to focus dwarf ${dwarfId}`, error)
      }
    }

    const provider = this.providers.find((item) => item.kind === dwarf.provider)
    if (provider === undefined) return { focused: false, openedTerminal: false, feed: [] }

    // No window to focus (or focusing it failed) — try opening a new terminal
    // tailing the transcript live before falling back to the static feed.
    const transcriptPath = provider.transcriptPath?.(dwarfId)
    if (transcriptPath !== undefined) {
      try {
        if (await this.launchTerminal(dwarf.name, transcriptPath)) {
          return { focused: false, openedTerminal: true, feed: [] }
        }
      } catch (error) {
        console.warn(`[runtime] Failed to open a terminal for ${dwarfId}`, error)
      }
    }

    try {
      return {
        focused: false,
        openedTerminal: false,
        feed: (await provider.feed(dwarfId, FEED_LIMIT)) ?? []
      }
    } catch (error) {
      console.warn(`[runtime] Failed to read feed for ${dwarfId}`, error)
      return { focused: false, openedTerminal: false, feed: [] }
    }
  }
}
