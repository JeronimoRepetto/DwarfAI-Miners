import type { FsLike } from '../adapters/fsLike'
import type { MineTier } from '../domain/types'

/** Byte-size thresholds, expressed in KB, at which a mine upgrades to the next tier. */
export interface TierThresholds {
  copperKb: number
  silverKb: number
  goldKb: number
  uraniumKb: number
}

/** One kibibyte, in bytes — the unit the env vars and README table are expressed in. */
const BYTES_PER_KB = 1024

/**
 * Directories that never count toward project weight. `release` and `build`
 * were added after measuring a packaged project: `release/` alone held 836 MB
 * of a 1 536 MB checkout, none of it hand-written source (see #37).
 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  '.venv',
  'target',
  'release',
  'build'
])

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

/** Decides a tier from the total byte weight of a project's source files. */
export function tierForBytes(totalBytes: number, thresholds: TierThresholds): MineTier {
  if (totalBytes >= thresholds.uraniumKb * BYTES_PER_KB) return 'uranium'
  if (totalBytes >= thresholds.goldKb * BYTES_PER_KB) return 'gold'
  if (totalBytes >= thresholds.silverKb * BYTES_PER_KB) return 'silver'
  if (totalBytes >= thresholds.copperKb * BYTES_PER_KB) return 'copper'
  return 'bronze'
}

function isSourceFile(name: string): boolean {
  const dotAt = name.lastIndexOf('.')
  if (dotAt <= 0) return false
  return SOURCE_EXTENSIONS.has(name.slice(dotAt + 1).toLowerCase())
}

/**
 * Bounded breadth-first walk summing the byte size of source files under
 * `path`, skipping dependency/build directories and stopping once `cap`
 * files have been visited. The cap bounds files visited (one `stat` each),
 * not bytes accumulated — a project can still cross it well before its true
 * total is reached, same as the old count-based walk.
 */
export async function sumSourceBytes(fs: FsLike, path: string, cap: number): Promise<number> {
  let totalBytes = 0
  let filesSeen = 0
  const queue: string[] = [path]
  while (queue.length > 0 && filesSeen < cap) {
    const dir = queue.shift()!
    for (const entry of await fs.listDir(dir)) {
      if (entry.isDirectory) {
        if (!SKIP_DIRS.has(entry.name)) queue.push(`${dir}\\${entry.name}`)
        continue
      }
      if (isSourceFile(entry.name)) {
        filesSeen++
        const stat = await fs.stat(`${dir}\\${entry.name}`)
        totalBytes += stat?.size ?? 0
        if (filesSeen >= cap) return totalBytes
      }
    }
  }
  return totalBytes
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
    const totalBytes = await sumSourceBytes(this.fs, path, this.fileCap)
    // No migration on upgrade: the vault seals each token delta with the
    // tier in force when it was observed (#22), so material already mined
    // keeps its old-tier identity. Recomputing the tier here only decides
    // which tier newly observed mining from this point forward falls under.
    this.cache.set(key, { tier: tierForBytes(totalBytes, this.thresholds), computedAt: this.now() })
  }
}
