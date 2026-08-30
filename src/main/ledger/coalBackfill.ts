import { join } from 'node:path'
import type { FsLike } from '../adapters/fsLike'
import { mineIdForPath } from '../domain/aggregate'
import { currentPlatform, type Platform } from '../platform/platform'
import { claudeCoalFromTail, codexCoalFromRollout } from './coalScan'
import { writeFileAtomic, type LedgerFsLike } from './ledgerStore'

/**
 * The one-time historical scan that fills the coal pile (see #22).
 *
 * Coal is the material of every token burned BEFORE this app was installed.
 * It has no mine tier and never accrues from live polling: it is produced once,
 * here, by reading what the two providers already left on disk.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS NUMBER IS, AND WHAT IT IS NOT
 * ---------------------------------------------------------------------------
 * These trees can be gigabytes, and a backfill that blocks startup or re-reads
 * them on every launch would be a worse bug than the one it fixes. So the scan
 * is bounded, resumable, and deliberately incomplete in known ways. The coal
 * total is an honest floor on pre-install usage, not a reconciliation.
 *
 * It DOES include:
 *  - Every top-level Claude transcript under `<root>/projects/<dir>/*.jsonl`
 *    whose newest record pre-dates the install moment, counted the same way
 *    the live provider counts a session (the LAST usage block, never a sum).
 *  - Every Codex rollout under `<sessionsRoot>/YYYY/MM/DD/rollout-*.jsonl`
 *    that pre-dates the install moment, counted from the last `token_count`
 *    record's running `total_token_usage.total_tokens`.
 *
 * It does NOT include:
 *  - Claude SUBAGENT transcripts (`<projectDir>/<sessionId>/subagents/*.jsonl`).
 *    Reaching them means a second directory level per session, which multiplies
 *    the walk for a pile whose precision nobody reads. Their tokens are simply
 *    absent from the coal figure.
 *  - Anything beyond `maxFilesPerDir` files in a single project directory or
 *    a single Codex day. A very busy day is sampled, not exhausted.
 *  - Any session still writing across the install moment. Its tokens go to
 *    live accrual instead, so they are counted once as ore rather than twice.
 *  - Any transcript that never recorded usage, or that carries no `cwd` to
 *    attribute it to a project.
 *  - History on a machine where the app was installed long ago: the install
 *    moment is captured the first time this runs, so it can only ever mean
 *    "first launch of a build that had this feature".
 */

/** Bumped only for a marker shape a previous version could misread. */
export const COAL_BACKFILL_VERSION = 1

/** Files whose CONTENTS are read in one run, before the scan defers the rest. */
export const DEFAULT_MAX_FILES = 1_500

/** Wall-clock budget for one run. Startup must stay responsive. */
export const DEFAULT_MAX_DURATION_MS = 8_000

/** Files read from a single project directory or Codex day, ever. */
export const DEFAULT_MAX_FILES_PER_DIR = 400

/**
 * Bytes read from the end of a Claude transcript. Every line carries the cwd
 * and the last usage block is what counts, so the tail alone answers both
 * questions however large the file is.
 */
export const CLAUDE_TAIL_BYTES = 64 * 1024

/** Bytes read from the start of a Codex rollout, where session_meta lives. */
export const CODEX_HEAD_BYTES = 16 * 1024

/** Bytes read from the end of a Codex rollout, for the last token_count. */
export const CODEX_TAIL_BYTES = 128 * 1024

const ROLLOUT_RE = /^rollout-.*\.jsonl$/
const YEAR_RE = /^\d{4}$/
const MONTH_OR_DAY_RE = /^\d{2}$/

/**
 * What a previous run recorded.
 *
 * `installedAt` is the whole boundary between history and live mining, so it
 * is captured once and never recomputed — a moving boundary would let each
 * launch reclassify a little more live usage as history.
 *
 * `credited` lists the scan units already paid in. It is how a run that hit
 * its budget resumes without paying twice, and it is dropped once `done`.
 */
export interface BackfillMarker {
  version: number
  installedAt: number
  credited: string[]
  done: boolean
}

export interface CoalBackfillResult {
  /** False when a previous run had already finished the whole scan. */
  ran: boolean
  /** True when every unit has now been visited; false means resume next launch. */
  done: boolean
  /** Files whose contents were actually read this run. */
  filesRead: number
  /** Projects credited this run. */
  projectsCredited: number
  /** Coal tokens credited this run. */
  tokensCredited: number
}

export interface CoalBackfillOptions {
  /** Read-only filesystem port for the transcript trees. */
  fs: FsLike
  /** Read/write port for the marker; the same shape the ledger store uses. */
  markerFs: LedgerFsLike
  markerPath: string
  /** Claude config roots, already home-expanded. */
  claudeRoots: readonly string[]
  /** Codex sessions root, already home-expanded. */
  codexSessionsRoot: string
  /** Pays coal into the vault. Called once per project per unit. */
  credit: (mineId: string, tokens: number) => void
  now: () => number
  platform?: Platform
  maxFiles?: number
  maxDurationMs?: number
  maxFilesPerDir?: number
  warn?: (message: string, error: unknown) => void
}

/** One directory the scan treats as an all-or-nothing unit of work. */
interface ScanUnit {
  kind: 'claude' | 'codex'
  path: string
}

function parseMarker(raw: string): BackfillMarker | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    // A marker this code does not understand is treated as absent: better to
    // rescan (which credits nothing twice, thanks to `credited`) than to
    // half-read a shape from another version.
    if (record.version !== COAL_BACKFILL_VERSION) return null
    if (typeof record.installedAt !== 'number' || !Number.isFinite(record.installedAt)) return null
    const credited = Array.isArray(record.credited)
      ? record.credited.filter((entry): entry is string => typeof entry === 'string')
      : []
    return {
      version: COAL_BACKFILL_VERSION,
      installedAt: record.installedAt,
      credited,
      done: record.done === true
    }
  } catch {
    return null
  }
}

async function loadMarker(fs: LedgerFsLike, path: string): Promise<BackfillMarker | null> {
  try {
    return parseMarker(await fs.readFile(path, 'utf8'))
  } catch {
    // Missing is the first-run case; unreadable is treated the same way.
    return null
  }
}

/**
 * Every Claude project directory under every configured root. The directory
 * NAME is never decoded — it is a lossy encoding of the cwd — so it serves
 * only as a unit key; the real project comes from inside each transcript.
 */
async function claudeUnits(fs: FsLike, roots: readonly string[]): Promise<ScanUnit[]> {
  const units: ScanUnit[] = []
  for (const root of roots) {
    const projects = join(root, 'projects')
    for (const entry of await fs.listDir(projects)) {
      if (entry.isDirectory) units.push({ kind: 'claude', path: join(projects, entry.name) })
    }
  }
  return units
}

/**
 * Every Codex day directory, walking the YYYY/MM/DD layout.
 *
 * Names are matched against the date shape rather than accepted wholesale, so
 * an unrelated folder someone dropped in the sessions root cannot send the
 * scan wandering through an arbitrary tree.
 */
async function codexUnits(fs: FsLike, sessionsRoot: string): Promise<ScanUnit[]> {
  const units: ScanUnit[] = []
  for (const year of await fs.listDir(sessionsRoot)) {
    if (!year.isDirectory || !YEAR_RE.test(year.name)) continue
    const yearPath = join(sessionsRoot, year.name)
    for (const month of await fs.listDir(yearPath)) {
      if (!month.isDirectory || !MONTH_OR_DAY_RE.test(month.name)) continue
      const monthPath = join(yearPath, month.name)
      for (const day of await fs.listDir(monthPath)) {
        if (!day.isDirectory || !MONTH_OR_DAY_RE.test(day.name)) continue
        units.push({ kind: 'codex', path: join(monthPath, day.name) })
      }
    }
  }
  return units
}

/**
 * Read one file's contribution, or null when it proves nothing.
 *
 * The mtime gate comes first and costs no read: a file touched at or after the
 * install moment belongs to live accrual, and most of the recent tree is
 * dismissed for the price of a stat. The record timestamp then confirms it,
 * because an old mtime is not proof that the content is old.
 */
async function readCoal(
  fs: FsLike,
  unit: ScanUnit,
  filePath: string,
  installedAt: number
): Promise<{ cwd: string; tokens: number } | null> {
  const stat = await fs.stat(filePath)
  if (stat === null || stat.isDirectory || stat.mtimeMs >= installedAt) return null

  const record =
    unit.kind === 'claude'
      ? claudeCoalFromTail(await fs.readTextTail(filePath, CLAUDE_TAIL_BYTES))
      : codexCoalFromRollout(
          await fs.readTextHead(filePath, CODEX_HEAD_BYTES),
          await fs.readTextTail(filePath, CODEX_TAIL_BYTES)
        )

  if (record === null || record.lastRecordAt >= installedAt) return null
  return { cwd: record.cwd, tokens: record.tokens }
}

/**
 * Scan one directory whole, returning what it owes each project.
 *
 * Credits are accumulated and returned rather than paid as they are found, so
 * the caller can treat a unit as atomic: a unit is either credited completely
 * and recorded, or abandoned and retried from scratch on the next launch.
 * Partial credit plus a recorded unit would silently lose tokens; partial
 * credit without one would double-count them.
 */
async function scanUnit(
  options: CoalBackfillOptions,
  unit: ScanUnit,
  installedAt: number,
  maxFilesPerDir: number,
  platform: Platform
): Promise<{ credits: Map<string, number>; filesRead: number }> {
  const credits = new Map<string, number>()
  let filesRead = 0

  const entries = await options.fs.listDir(unit.path)
  for (const entry of entries) {
    if (filesRead >= maxFilesPerDir) break
    if (entry.isDirectory) continue
    const matches =
      unit.kind === 'claude' ? entry.name.endsWith('.jsonl') : ROLLOUT_RE.test(entry.name)
    if (!matches) continue

    const filePath = join(unit.path, entry.name)
    filesRead++
    try {
      const coal = await readCoal(options.fs, unit, filePath, installedAt)
      if (coal === null) continue
      const mineId = mineIdForPath(coal.cwd, platform)
      credits.set(mineId, (credits.get(mineId) ?? 0) + coal.tokens)
    } catch (error) {
      // One unreadable transcript must not cost the whole directory.
      options.warn?.(`[coal] Skipped an unreadable historical transcript in ${unit.path}:`, error)
    }
  }

  return { credits, filesRead }
}

/**
 * Run the backfill, or discover that a previous run already finished it.
 *
 * Never throws: a historical curiosity must not be able to stop the app from
 * starting. Failures are reported through `warn` and leave the marker saying
 * the scan is unfinished, so the next launch simply tries again.
 */
export async function runCoalBackfill(options: CoalBackfillOptions): Promise<CoalBackfillResult> {
  const platform = options.platform ?? currentPlatform()
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES
  const maxDurationMs = options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS
  const maxFilesPerDir = options.maxFilesPerDir ?? DEFAULT_MAX_FILES_PER_DIR

  const marker = await loadMarker(options.markerFs, options.markerPath)
  if (marker?.done === true) {
    return { ran: false, done: true, filesRead: 0, projectsCredited: 0, tokensCredited: 0 }
  }

  // First run defines the boundary; every later run must honour that same
  // moment or it would keep reclassifying live usage as history.
  const installedAt = marker?.installedAt ?? options.now()
  const credited = new Set(marker?.credited ?? [])

  const units = [
    ...(await claudeUnits(options.fs, options.claudeRoots)),
    ...(await codexUnits(options.fs, options.codexSessionsRoot))
  ]

  const startedAt = options.now()
  let filesRead = 0
  let tokensCredited = 0
  let projectsCredited = 0
  let done = true

  for (const unit of units) {
    if (credited.has(unit.path)) continue

    // Budget is checked BETWEEN units, never inside one, and never before the
    // first. A run that completed no unit would record no progress, so an
    // over-tight budget would leave the scan unfinished forever however many
    // times the app was launched. maxFilesPerDir is what bounds a single unit.
    if (filesRead > 0 && (filesRead >= maxFiles || options.now() - startedAt >= maxDurationMs)) {
      done = false
      break
    }

    const scanned = await scanUnit(options, unit, installedAt, maxFilesPerDir, platform)
    filesRead += scanned.filesRead
    for (const [mineId, tokens] of scanned.credits) {
      options.credit(mineId, tokens)
      tokensCredited += tokens
      projectsCredited++
    }
    credited.add(unit.path)
  }

  const next: BackfillMarker = {
    version: COAL_BACKFILL_VERSION,
    installedAt,
    // Once finished the list has no further use, and dropping it keeps the
    // marker from carrying one line per project directory forever.
    credited: done ? [] : [...credited],
    done
  }
  try {
    await writeFileAtomic(options.markerFs, options.markerPath, `${JSON.stringify(next)}\n`)
  } catch (error) {
    // The coal is already in the ledger. Failing to record that means the next
    // launch rescans, which credits the same units again — but that is a
    // persistence failure the user can see and fix, and it is strictly better
    // than refusing to start.
    options.warn?.('[coal] Failed to record the historical backfill marker:', error)
  }

  return { ran: true, done, filesRead, projectsCredited, tokensCredited }
}
