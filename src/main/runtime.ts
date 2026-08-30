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
  Mine,
  TextDeliveryChannel
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
import { createStageTimer, formatStageTimings, type StageTimings } from './textDelivery/timing'
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

/** Stands in for a channel that failed without saying why, so the combined verdict never reads 'undefined'. */
const NO_REASON_GIVEN = 'It failed without a reason.'

/**
 * Both channels were tried and both failed: the panel's ✕ tooltip must carry
 * both stories — terminal first, since that is the channel the user expected —
 * each on its own labeled line so neither reason reads as the other's.
 */
function combineFallbackErrors(
  terminalError: string | undefined,
  relayError: string | undefined
): string {
  return (
    `Terminal: ${terminalError ?? NO_REASON_GIVEN}\n` +
    `Relay fallback: ${relayError ?? NO_REASON_GIVEN}`
  )
}

/**
 * The stage breakdown appended to a delivery's log line, e.g.
 * ` [focus=12ms spawn=30ms total=45ms]` (issue #21).
 *
 * A Kick or Send that "feels slow" used to be unfalsifiable: the log carried a
 * verdict and nothing else, so every latency discussion started from a guess.
 * These are durations only — the privacy rule is unchanged, and there is
 * nothing in a StageTimings that could carry a payload even by accident.
 */
function stageSuffix(timings: StageTimings): string {
  const formatted = formatStageTimings(timings)
  return formatted === '' ? '' : ` [${formatted}]`
}

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
  /** Shared by the lifecycle grace window and the delivery stage timings. */
  private readonly now: () => number
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
        roots: options.config.claudeConfigDirs.map((path) => expandHomePath(path, home)),
        // The pid-reuse guard's source of truth: a registry entry only counts
        // as alive when the pid's real creation time matches its procStart.
        processStartTimeMs: (pid) => platform.processProbe.processStartTimeMs(pid)
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
    this.now = options.now ?? Date.now

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

  /**
   * Also releases whatever the delivery tier keeps alive between actions — the
   * long-lived console shell, today. index.ts already calls this on
   * 'before-quit', so a quit never leaves a stray powershell.exe behind.
   */
  stop(): void {
    this.poller.stop()
    this.textDelivery.dispose?.()
  }

  /** Execute a deterministic scan for IPC/tests without starting an interval. */
  async refresh(): Promise<void> {
    await this.poller.tick()
  }

  /**
   * Report that something outside the poller says the state just changed —
   * today, a Claude Code hook arriving on the loopback listener.
   *
   * Deliberately fire-and-forget and deliberately coarse: it asks for a full
   * rescan rather than trying to update one session, so the push channel reuses
   * the same already-tested scan path and can never produce a state the regular
   * poll would not have produced two seconds later.
   */
  nudge(): void {
    this.poller.nudge()
  }

  getMines(): Mine[] {
    return this.mines
  }

  /**
   * Ask whichever provider owns `dwarfId` how a message could reach it. A
   * provider that predates the capability surface (or does not implement it)
   * simply reports no channel.
   *
   * A 'terminal' target is degraded on platforms whose delivery port cannot
   * type into a console (macOS until its osascript path is verified, Linux
   * always): to its relay address when the session carries one — the relay
   * spawns a CLI, so it works on every platform — and to no channel at all
   * otherwise. Providers answer from what the SESSION offers, which is a fact
   * about the session, not about this machine; intersecting the two here is
   * what makes the panel show a working relay Send (or a disabled button with
   * a reason) instead of a Send that quietly types nowhere.
   */
  private deliveryTargetOf(dwarfId: string): TextDeliveryTarget | null {
    const consoleSupported = this.textDelivery.supportsConsoleInput !== false
    for (const provider of this.providers) {
      const target = provider.textDelivery?.(dwarfId)
      if (target === undefined || target === null) continue
      if (target.kind === 'terminal' && !consoleSupported) {
        return target.sessionName === undefined
          ? null
          : { kind: 'claude-relay', sessionName: target.sessionName }
      }
      return target
    }
    return null
  }

  /**
   * Second attempt behind a failed console delivery (issue #24): an
   * interactive session with a registry name is also relay-addressable, so a
   * window that cannot be focused or typed into no longer swallows the
   * payload — the exact same text goes over the relay instead. On success the
   * verdict names 'claude-relay', the channel that actually delivered, so the
   * panel's ✓ stays honest; on a double failure it carries both reasons,
   * terminal first. Logs the verdict only, never the text.
   */
  private async relayFallback(options: {
    dwarfId: string
    /** Only for the log line — the payload is already the right one for the attempt. */
    attempt: 'message' | 'kick'
    /** The channel the verdict reports when the fallback fails too. */
    channel: TextDeliveryChannel
    sessionName: string
    text: string
    terminalError: string | undefined
  }): Promise<DwarfTextResult> {
    // A second attempt is a second attempt: it gets its own timings rather than
    // being folded into the console attempt that failed before it.
    const timer = createStageTimer(this.now)
    const relay = await timer.measure('total', () =>
      timer.measure('relay', () =>
        this.textDelivery.relayToClaudeSession({
          sessionName: options.sessionName,
          text: options.text
        })
      )
    )
    timer.absorb(relay.stages)
    console.log(
      `[runtime] Relay fallback (${options.attempt}) for ${options.dwarfId}: ` +
        `${relay.delivered ? 'delivered' : 'failed'}${stageSuffix(timer.timings())}`
    )
    return relay.delivered
      ? { delivered: true, via: 'claude-relay' }
      : {
          delivered: false,
          via: options.channel,
          error: combineFallbackErrors(options.terminalError, relay.error)
        }
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
    const endpoint = resolved.endpoint
    const timer = createStageTimer(this.now)
    try {
      // 'total' is everything the caller waited for; the tier below reports the
      // stages only it can see (focus, spawn), and the relay call is timed here
      // because the runtime is what makes it.
      const outcome = await timer.measure('total', () =>
        endpoint.kind === 'terminal'
          ? this.textDelivery.sendToConsole({
              pid: endpoint.pid,
              text: payload,
              pressEnter: request.pressEnter
            })
          : timer.measure('relay', () =>
              this.textDelivery.relayToClaudeSession({
                sessionName: endpoint.sessionName,
                text: payload
              })
            )
      )
      timer.absorb(outcome.stages)
      console.log(
        `[runtime] Message to ${request.dwarfId} via ${resolved.channel}: ` +
          `${outcome.delivered ? 'delivered' : 'failed'} (${payload.length} chars)` +
          stageSuffix(timer.timings())
      )
      if (outcome.delivered) return { delivered: true, via: resolved.channel }
      // The console attempt failed, but a session with a registry name is
      // also relay-addressable: same payload, second channel (issue #24).
      if (resolved.endpoint.kind === 'terminal' && resolved.endpoint.sessionName !== undefined) {
        return this.relayFallback({
          dwarfId: request.dwarfId,
          attempt: 'message',
          channel: resolved.channel,
          sessionName: resolved.endpoint.sessionName,
          text: payload,
          terminalError: outcome.error
        })
      }
      return { delivered: false, via: resolved.channel, error: outcome.error }
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

    const endpoint = resolved.endpoint
    const timer = createStageTimer(this.now)
    try {
      // Note what this does NOT do: there is no harsher second tier here, and
      // no escalation flag to raise. A repeated kick repeats this exact polite
      // interrupt — see the kick escalation policy tests.
      const outcome = await timer.measure('total', () =>
        endpoint.kind === 'terminal'
          ? this.textDelivery.sendInterrupt({ pid: endpoint.pid })
          : timer.measure('relay', () =>
              this.textDelivery.relayToClaudeSession({
                sessionName: endpoint.sessionName,
                text:
                  resolved.prefix === ''
                    ? CANCEL_INSTRUCTION
                    : `${resolved.prefix}${CANCEL_WORKER_INSTRUCTION}`
              })
            )
      )
      timer.absorb(outcome.stages)
      console.log(
        `[runtime] Kick for ${request.dwarfId} via ${resolved.channel}: ` +
          `${outcome.delivered ? 'delivered' : 'failed'}${stageSuffix(timer.timings())}`
      )
      if (outcome.delivered) return { delivered: true, via: resolved.channel }
      // Same fallback as sendDwarfText, carrying the exact instruction the
      // relay tier already uses — a kick has no user text, only this message.
      if (resolved.endpoint.kind === 'terminal' && resolved.endpoint.sessionName !== undefined) {
        return this.relayFallback({
          dwarfId: request.dwarfId,
          attempt: 'kick',
          channel: resolved.channel,
          sessionName: resolved.endpoint.sessionName,
          text:
            resolved.prefix === ''
              ? CANCEL_INSTRUCTION
              : `${resolved.prefix}${CANCEL_WORKER_INSTRUCTION}`,
          terminalError: outcome.error
        })
      }
      return { delivered: false, via: resolved.channel, error: outcome.error }
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
