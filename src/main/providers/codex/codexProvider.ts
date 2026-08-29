import type { FsLike } from '../../adapters/fsLike'
import type { Dwarf, FeedMessage, ProviderSnapshot } from '../../domain/types'
import type { Provider } from '../provider'
import { extractCodexFeed, parseCodexRolloutHead, parseCodexRolloutTail } from './parse'

const HEAD_BYTES = 64 * 1024
const TAIL_BYTES = 256 * 1024
const ROLLOUT_RE = /^rollout-.*\.jsonl$/

export interface CodexProviderOptions {
  fs: FsLike
  /** The ~/.codex/sessions directory. */
  sessionsRoot: string
  /** A rollout counts as live while its mtime is at most this many seconds old. */
  livenessWindowS: number
  now?: () => number
}

function datePath(date: Date): string {
  const year = String(date.getFullYear())
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}\\${month}\\${day}`
}

/**
 * Detects live Codex CLI sessions from rollout files under
 * ~/.codex/sessions/YYYY/MM/DD/. Codex writes no pid/lock files, so liveness
 * is mtime-based: a rollout touched within the liveness window counts as an
 * open session; an unmatched task_started marks it busy.
 */
export class CodexProvider implements Provider {
  readonly kind = 'codex' as const

  private readonly fs: FsLike
  private readonly sessionsRoot: string
  private readonly livenessWindowS: number
  private readonly now: () => number
  /** dwarfId -> rollout path, rebuilt on every scan (used by feed()). */
  private readonly feedSources = new Map<string, string>()

  constructor(options: CodexProviderOptions) {
    this.fs = options.fs
    this.sessionsRoot = options.sessionsRoot
    this.livenessWindowS = options.livenessWindowS
    this.now = options.now ?? Date.now
  }

  async scan(): Promise<ProviderSnapshot[]> {
    this.feedSources.clear()
    const nowMs = this.now()
    const freshAfter = nowMs - this.livenessWindowS * 1_000
    const today = new Date(nowMs)
    const yesterday = new Date(nowMs - 24 * 60 * 60 * 1_000)

    const snapshots: ProviderSnapshot[] = []
    const seenSessions = new Set<string>()
    for (const day of [datePath(today), datePath(yesterday)]) {
      const dir = `${this.sessionsRoot}\\${day}`
      for (const entry of await this.fs.listDir(dir)) {
        if (entry.isDirectory || !ROLLOUT_RE.test(entry.name)) continue
        const path = `${dir}\\${entry.name}`
        const stat = await this.fs.stat(path)
        if (stat === null || stat.mtimeMs < freshAfter) continue
        const snapshot = await this.snapshotRollout(path, stat.mtimeMs)
        if (snapshot === null || seenSessions.has(snapshot.sessionId)) continue
        seenSessions.add(snapshot.sessionId)
        snapshots.push(snapshot)
      }
    }
    return snapshots
  }

  async feed(dwarfId: string, limit: number): Promise<FeedMessage[] | null> {
    const path = this.feedSources.get(dwarfId)
    if (path === undefined) return null
    if (!(await this.fs.exists(path))) return []
    return extractCodexFeed(await this.fs.readTextTail(path, TAIL_BYTES), limit)
  }

  private async snapshotRollout(path: string, mtimeMs: number): Promise<ProviderSnapshot | null> {
    const head = parseCodexRolloutHead(await this.fs.readTextHead(path, HEAD_BYTES))
    if (head === null) return null
    const info = parseCodexRolloutTail(await this.fs.readTextTail(path, TAIL_BYTES))

    const dwarfId = `codex:${head.sessionId}`
    this.feedSources.set(dwarfId, path)

    const dwarfs: Dwarf[] = []
    if (info.busy) {
      dwarfs.push({
        id: dwarfId,
        provider: 'codex',
        role: 'worker',
        name: `codex-${head.sessionId.slice(0, 8)}`,
        model: info.model,
        effort: info.effort,
        status: 'working',
        lastMessage: info.lastMessage,
        sessionId: head.sessionId
      })
    }

    return {
      provider: 'codex',
      sessionId: head.sessionId,
      cwd: head.cwd,
      status: info.busy ? 'busy' : 'idle',
      dwarfs,
      updatedAt: mtimeMs
    }
  }
}
