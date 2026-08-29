import type { FsLike } from '../adapters/fsLike'
import type { MineTier } from '../domain/types'

/** File counts at which a mine upgrades to the next tier. */
export interface TierThresholds {
  copperAt: number
  silverAt: number
  goldAt: number
  uraniumAt: number
}

/** Directories that never count toward project complexity. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', '.venv', 'target'])

/** Extensions considered "source-ish" for the complexity heuristic. */
const SOURCE_EXTENSIONS = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'vue',
  'svelte',
  'py',
  'go',
  'rs',
  'java',
  'kt',
  'kts',
  'cs',
  'c',
  'h',
  'cpp',
  'hpp',
  'cc',
  'rb',
  'php',
  'swift',
  'scala',
  'lua',
  'sql',
  'sh',
  'ps1',
  'html',
  'css',
  'scss',
  'less'
])

/** Default cap: stop walking once this many source files have been counted. */
const DEFAULT_FILE_CAP = 3000

export function tierForCount(count: number, thresholds: TierThresholds): MineTier {
  if (count >= thresholds.uraniumAt) return 'uranium'
  if (count >= thresholds.goldAt) return 'gold'
  if (count >= thresholds.silverAt) return 'silver'
  if (count >= thresholds.copperAt) return 'copper'
  return 'bronze'
}

function isSourceFile(name: string): boolean {
  const dotAt = name.lastIndexOf('.')
  if (dotAt <= 0) return false
  return SOURCE_EXTENSIONS.has(name.slice(dotAt + 1).toLowerCase())
}

/**
 * Bounded breadth-first walk counting source files under `path`, skipping
 * dependency/build directories and stopping at `cap` files.
 */
export async function countSourceFiles(fs: FsLike, path: string, cap: number): Promise<number> {
  let count = 0
  const queue: string[] = [path]
  while (queue.length > 0 && count < cap) {
    const dir = queue.shift()!
    for (const entry of await fs.listDir(dir)) {
      if (entry.isDirectory) {
        if (!SKIP_DIRS.has(entry.name)) queue.push(`${dir}\\${entry.name}`)
        continue
      }
      if (isSourceFile(entry.name)) {
        count++
        if (count >= cap) return count
      }
    }
  }
  return count
}

export interface TierServiceOptions {
  fs: FsLike
  thresholds: TierThresholds
  /** Computed tiers stay cached this many seconds. */
  ttlS: number
  now?: () => number
  fileCap?: number
}

interface CacheEntry {
  tier: MineTier
  computedAt: number
}

/**
 * Complexity tier per project path. tierOf() never blocks: it serves the
 * cached tier (or bronze while the first walk is pending) and refreshes the
 * cache in the background when stale. Paths are compared case-insensitively
 * (win32 semantics).
 */
export class TierService {
  private readonly fs: FsLike
  private readonly thresholds: TierThresholds
  private readonly ttlMs: number
  private readonly now: () => number
  private readonly fileCap: number
  private readonly cache = new Map<string, CacheEntry>()
  private readonly inFlight = new Map<string, Promise<void>>()

  constructor(options: TierServiceOptions) {
    this.fs = options.fs
    this.thresholds = options.thresholds
    this.ttlMs = options.ttlS * 1_000
    this.now = options.now ?? Date.now
    this.fileCap = options.fileCap ?? DEFAULT_FILE_CAP
  }

  /** Current tier for a project path; bronze while the first walk is pending. */
  tierOf(path: string): MineTier {
    const key = path.toLowerCase()
    const cached = this.cache.get(key)
    const stale = cached === undefined || this.now() - cached.computedAt >= this.ttlMs
    if (stale && !this.inFlight.has(key)) {
      const refresh = this.refresh(key, path).catch(() => undefined)
      this.inFlight.set(
        key,
        refresh.finally(() => this.inFlight.delete(key))
      )
    }
    return cached?.tier ?? 'bronze'
  }

  /** Resolves when every in-flight walk has finished (poller drain + tests). */
  async settle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.all([...this.inFlight.values()])
    }
  }

  private async refresh(key: string, path: string): Promise<void> {
    const count = await countSourceFiles(this.fs, path, this.fileCap)
    this.cache.set(key, { tier: tierForCount(count, this.thresholds), computedAt: this.now() })
  }
}
