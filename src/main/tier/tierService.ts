import { createHash } from 'node:crypto'
import { join } from 'node:path'
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

/**
 * Per-file byte ceiling above which a "source" file is treated as a bundle,
 * minified artifact, or generated data rather than something a person typed
 * (#39). 300 KB is comfortably above even a long hand-written file, and
 * roughly 8x smaller than the 2.3 MB vendored `player-script.js` that first
 * inflated a gold-sized project (~2 MB) to a uranium-sized one (~16 MB) by
 * itself. A file over the ceiling is skipped outright rather than counted.
 */
export const BUNDLE_SIZE_CEILING_BYTES = 300 * 1024

/**
 * Filename suffixes that conventionally mark generated output (#39), matched
 * case-insensitively regardless of directory. `.map` is included for when
 * SOURCE_EXTENSIONS ever admits a `.map`-shaped extension: today no extension
 * in that set ends in "map", so isSourceFile() already excludes source maps
 * and this entry is a forward-looking no-op rather than a reachable path.
 */
const GENERATED_NAME_SUFFIXES = ['.min.js', '.min.css', '.bundle.js', '-bundle.js', '.map']

function isGeneratedName(name: string): boolean {
  const lower = name.toLowerCase()
  return GENERATED_NAME_SUFFIXES.some((suffix) => lower.endsWith(suffix))
}

/**
 * Bytes sampled from the START of a file to fingerprint it for duplicate
 * detection (#39). Reading a fixed, small prefix - rather than the whole file
 * - is what keeps dedup affordable under the same file cap and TTL that make
 * reading every whole file too expensive: the cost per file is bounded by
 * this constant, not by the file's real size.
 *
 * Fingerprint = file size + hash of this prefix. For any file at or under
 * this many bytes the "prefix" is the entire file, so the fingerprint is
 * exact. Above it, two distinct files that happen to share both size and
 * first-4KB content would be misreported as duplicates - a known, accepted
 * false-positive risk given how cheap this check needs to stay (see #39).
 */
const DUPLICATE_SAMPLE_BYTES = 4096

function fingerprint(size: number, sample: string): string {
  return `${size}:${createHash('sha1').update(sample).digest('hex')}`
}

/** Why sumSourceBytes excluded a file from the byte sum. */
export type SkipReason = 'too-large' | 'generated-name' | 'duplicate'

/** One file sumSourceBytes decided not to count, and why (#39). */
export interface SkippedFile {
  reason: SkipReason
  path: string
  /** Present for every reason except 'generated-name', which is skipped before a stat. */
  size?: number
  /** Present only for reason 'duplicate': the first file this one repeats byte-for-byte. */
  duplicateOf?: string
}

export interface SumSourceBytesOptions {
  /**
   * Told about every file the walk excludes and why. Left undefined in the
   * common (non-debug) path so callers pay nothing for a report nobody asked
   * for - the tier service only supplies this when TIER_DEBUG is on (#39).
   */
  onSkip?: (skipped: SkippedFile) => void
}

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
 *
 * Three exclusions run before a file's bytes ever reach the sum (#39), so a
 * mine's weight tracks hand-written source rather than whatever a build tool
 * left lying around: a name matching a generated-output pattern, a size over
 * BUNDLE_SIZE_CEILING_BYTES, or a byte-identical duplicate of a file already
 * counted (see fingerprint()'s doc comment for that check's precision limit).
 * Every exclusion still spends one cap slot, matching the cap's own contract
 * of bounding files *visited* rather than bytes kept.
 *
 * Path segments are joined with `path.join`, never hand-rolled string
 * concatenation: a literal `\\` is not a separator on a POSIX filesystem, it
 * is one more character in a single bad filename, which silently zeroed this
 * walk's result on macOS/Linux.
 */
export async function sumSourceBytes(
  fs: FsLike,
  path: string,
  cap: number,
  options: SumSourceBytesOptions = {}
): Promise<number> {
  let totalBytes = 0
  let filesSeen = 0
  const queue: string[] = [path]
  // Fingerprint -> the first file that produced it, scoped to this one walk:
  // duplicates are collapsed within a mine, not across separate mines or runs.
  const seenFingerprints = new Map<string, string>()
  while (queue.length > 0 && filesSeen < cap) {
    const dir = queue.shift()!
    for (const entry of await fs.listDir(dir)) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory) {
        if (!SKIP_DIRS.has(entry.name)) queue.push(fullPath)
        continue
      }
      if (isSourceFile(entry.name)) {
        filesSeen++
        if (isGeneratedName(entry.name)) {
          options.onSkip?.({ reason: 'generated-name', path: fullPath })
        } else {
          const stat = await fs.stat(fullPath)
          const size = stat?.size ?? 0
          if (size > BUNDLE_SIZE_CEILING_BYTES) {
            options.onSkip?.({ reason: 'too-large', path: fullPath, size })
          } else {
            const sample = await fs.readTextHead(fullPath, DUPLICATE_SAMPLE_BYTES)
            const key = fingerprint(size, sample)
            const original = seenFingerprints.get(key)
            if (original === undefined) {
              seenFingerprints.set(key, fullPath)
              totalBytes += size
            } else {
              options.onSkip?.({ reason: 'duplicate', path: fullPath, size, duplicateOf: original })
            }
          }
        }
        if (filesSeen >= cap) return totalBytes
      }
    }
  }
  return totalBytes
}

/**
 * Debug-only visibility switch for the byte walk (#39): "why did this project
 * weigh what it did" is otherwise undiagnosable once files start getting
 * skipped. Mirrors perf.ts's DWARFAI_PERF flag - read straight from
 * process.env rather than AppConfig, because this is a debugging device, not
 * a product setting, and every TierService caller must get it without a
 * config round trip.
 */
const TIER_DEBUG_ENV_VAR = 'TIER_DEBUG'

/** Whether the tier walk reports the files it skipped, and why, for this process. */
export function tierDebugEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[TIER_DEBUG_ENV_VAR]
  if (raw === undefined) return false
  const normalized = raw.toLowerCase()
  return normalized === '1' || normalized === 'true'
}

/** One line per skipped file: reason, size (when known), path, and its original for a duplicate. */
function formatSkip(skipped: SkippedFile): string {
  const size = skipped.size !== undefined ? ` ${Math.round(skipped.size / 1024)}KB` : ''
  const duplicateOf =
    skipped.duplicateOf !== undefined ? ` (duplicate of ${skipped.duplicateOf})` : ''
  return `[tier] skip ${skipped.reason}${size} ${skipped.path}${duplicateOf}`
}

/** One closing line per walk: what it kept, then the tally of what it skipped and why. */
function formatSkipSummary(
  path: string,
  totalBytes: number,
  counts: Record<SkipReason, number>
): string {
  return (
    `[tier] ${path} counted ${Math.round(totalBytes / 1024)}KB | skipped ` +
    `too-large ${counts['too-large']} generated-name ${counts['generated-name']} duplicate ${counts.duplicate}`
  )
}

export interface TierServiceOptions {
  fs: FsLike
  thresholds: TierThresholds
  /** Computed tiers stay cached this many seconds. */
  ttlS: number
  now?: () => number
  fileCap?: number
  /** Debug-only: report skipped files and why (#39). Defaults to TIER_DEBUG; injected only for tests. */
  debug?: boolean
  /** Debug-only: where the skip report is printed. Defaults to console.log. */
  log?: (line: string) => void
}

interface CacheEntry {
  tier: MineTier
  computedAt: number
}

/**
 * One cache read: the tier to use, and whether a walk actually produced it.
 *
 * A stale entry still counts as computed — it is a real measurement, just an
 * older one. Only a path no walk has ever finished is unknown.
 */
interface TierReading {
  tier: MineTier
  computed: boolean
}

/**
 * Complexity tier per project path. tierOf() never blocks: it serves the
 * cached tier (or bronze while the first walk is pending) and refreshes the
 * cache in the background when stale. Paths are compared case-insensitively
 * (win32 semantics).
 *
 * Two accessors, because "bronze" alone cannot say whether it was measured
 * (#41): tierOf() is for DRAWING, where something has to be on screen for the
 * first frame; knownTierOf() is for anything that seals a value with a tier,
 * where a placeholder would become a permanent lie.
 */
export class TierService {
  private readonly fs: FsLike
  private readonly thresholds: TierThresholds
  private readonly ttlMs: number
  private readonly now: () => number
  private readonly fileCap: number
  private readonly debug: boolean
  private readonly log: (line: string) => void
  private readonly cache = new Map<string, CacheEntry>()
  private readonly inFlight = new Map<string, Promise<void>>()

  constructor(options: TierServiceOptions) {
    this.fs = options.fs
    this.thresholds = options.thresholds
    this.ttlMs = options.ttlS * 1_000
    this.now = options.now ?? Date.now
    this.fileCap = options.fileCap ?? DEFAULT_FILE_CAP
    this.debug = options.debug ?? tierDebugEnabled()
    this.log = options.log ?? ((line) => console.log(line))
  }

  /**
   * Current tier for a project path; bronze while the first walk is pending.
   *
   * That bronze is a placeholder, indistinguishable from a measured one. Use
   * it to draw, never to decide what something IS (see knownTierOf).
   */
  tierOf(path: string): MineTier {
    return this.read(path).tier
  }

  /**
   * The tier only once a walk has actually produced it — undefined while the
   * first one is still running (#41).
   *
   * The vault seals every token delta with the tier in force when it was
   * observed and never revisits it (#22), so a delta sealed with the
   * placeholder is wrong forever. Callers that accrue ask this one and skip
   * the mine until it answers; the tokens are not lost, because the provider
   * counters are cumulative and the delta spanning the wait is credited whole
   * on the first poll that knows the tier.
   */
  knownTierOf(path: string): MineTier | undefined {
    const reading = this.read(path)
    return reading.computed ? reading.tier : undefined
  }

  /**
   * The one cache read behind both accessors, so knownTierOf schedules the
   * same background walk tierOf does. A passive read would let a mine nobody
   * happens to be drawing stay unknown — and therefore unaccrued — forever.
   */
  private read(path: string): TierReading {
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
    return { tier: cached?.tier ?? 'bronze', computed: cached !== undefined }
  }

  /** Resolves when every in-flight walk has finished (poller drain + tests). */
  async settle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.all([...this.inFlight.values()])
    }
  }

  private async refresh(key: string, path: string): Promise<void> {
    // Nothing here allocates or branches when debug is off: onSkip stays
    // undefined and sumSourceBytes never builds a SkippedFile for it (#39).
    const counts: Record<SkipReason, number> = { 'too-large': 0, 'generated-name': 0, duplicate: 0 }
    const onSkip = this.debug
      ? (skipped: SkippedFile) => {
          counts[skipped.reason]++
          this.log(formatSkip(skipped))
        }
      : undefined
    const totalBytes = await sumSourceBytes(this.fs, path, this.fileCap, { onSkip })
    if (this.debug) this.log(formatSkipSummary(path, totalBytes, counts))
    // No migration on upgrade: the vault seals each token delta with the
    // tier in force when it was observed (#22), so material already mined
    // keeps its old-tier identity. Recomputing the tier here only decides
    // which tier newly observed mining from this point forward falls under.
    this.cache.set(key, { tier: tierForBytes(totalBytes, this.thresholds), computedAt: this.now() })
  }
}
