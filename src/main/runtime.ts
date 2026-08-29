import { homedir } from 'node:os'
import { join } from 'node:path'
import { NodeFs, type FsLike } from './adapters/fsLike'
import { NodeSqlite, type SqliteLike } from './adapters/sqliteLike'
import type { AppConfig } from './config'
import type { DwarfActivation, Mine } from '../shared/contracts'
import { DwarfLifecycleTracker } from './domain/lifecycle'
import { focusPid } from './focus'
import { Poller } from './poller'
import { ClaudeProvider } from './providers/claude/claudeProvider'
import { CodexProvider } from './providers/codex/codexProvider'
import type { Provider } from './providers/provider'
import {
  launchTranscriptViewer,
  resolveViewerScriptPath,
  type ViewerPathOptions
} from './terminalLauncher'
import { TierService } from './tier/tierService'

const FEED_LIMIT = 12

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
  private mines: Mine[] = []

  constructor(options: RuntimeOptions) {
    const home = options.home ?? homedir()
    const fs = options.fs ?? new NodeFs()
    this.providers = options.providers ?? [
      new ClaudeProvider({
        fs,
        roots: options.config.claudeConfigDirs.map((path) => expandHomePath(path, home))
      }),
      new CodexProvider({
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
    this.focus = options.focus ?? focusPid

    const appPaths: ViewerPathOptions = options.appPaths ?? {
      isPackaged: false,
      resourcesPath: process.resourcesPath ?? '',
      appPath: process.cwd()
    }
    this.launchTerminal =
      options.launchTerminal ??
      ((dwarfName, transcriptPath) =>
        launchTranscriptViewer({
          dwarfName,
          transcriptPath,
          viewerScriptPath: resolveViewerScriptPath(appPaths)
        }))

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
        const withLeaving = lifecycle.apply(mines)
        this.mines = withLeaving
        options.onMinesUpdated(withLeaving)
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
