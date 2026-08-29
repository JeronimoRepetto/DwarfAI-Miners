import { homedir } from 'node:os'
import { join } from 'node:path'
import { NodeFs, type FsLike } from './adapters/fsLike'
import type { AppConfig } from './config'
import type { DwarfActivation, Mine } from '../shared/contracts'
import { focusPid } from './focus'
import { Poller } from './poller'
import { ClaudeProvider } from './providers/claude/claudeProvider'
import { CodexProvider } from './providers/codex/codexProvider'
import type { Provider } from './providers/provider'
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
  providers?: Provider[]
  focus?: (pid: number) => Promise<boolean>
}

/**
 * Runtime bridge between disk-backed providers and Electron IPC. Keeping it
 * independent from Electron makes its lifecycle and activation behavior testable.
 */
export class AgentRuntime {
  private readonly providers: Provider[]
  private readonly poller: Poller
  private readonly focus: (pid: number) => Promise<boolean>
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
        sessionsRoot: join(home, '.codex', 'sessions'),
        livenessWindowS: options.config.codexLivenessWindowS
      })
    ]
    this.focus = options.focus ?? focusPid

    const tiers = new TierService({
      fs,
      thresholds: options.config.tierThresholds,
      ttlS: options.config.tierCacheTtlS
    })
    this.poller = new Poller({
      providers: this.providers,
      intervalMs: options.config.pollIntervalMs,
      tierOf: (path) => tiers.tierOf(path),
      onUpdate: (mines) => {
        this.mines = mines
        options.onMinesUpdated(mines)
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
    if (dwarf === undefined) return { focused: false, feed: [] }

    if (dwarf.pid !== undefined) {
      try {
        if (await this.focus(dwarf.pid)) {
          return { focused: true, feed: [] }
        }
      } catch (error) {
        console.warn(`[runtime] Failed to focus dwarf ${dwarfId}`, error)
      }
    }

    const provider = this.providers.find((item) => item.kind === dwarf.provider)
    if (provider === undefined) return { focused: false, feed: [] }
    try {
      return { focused: false, feed: (await provider.feed(dwarfId, FEED_LIMIT)) ?? [] }
    } catch (error) {
      console.warn(`[runtime] Failed to read feed for ${dwarfId}`, error)
      return { focused: false, feed: [] }
    }
  }
}
