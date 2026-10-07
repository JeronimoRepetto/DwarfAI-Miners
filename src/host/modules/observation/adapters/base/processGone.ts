// Closing an observed session by its process (owner amendment I, 2026-10-07; 13 FM-059 as amended
// for Codex and OpenCode): neither provider's files say a session ended, and a departure is never
// inferred from silence or time alone (BR-11, INV-26, S26.17). A session closes once ALL hold:
//
// 1. it shows no activity for at least PROCESS_GONE_QUIET_MS (the adapter says what activity is);
// 2. a readable process listing (`ProcessControl.listProcesses`) shows no process of its provider
//    whose working folder is the session's folder;
// 3. that absence holds on two listings at least PROCESS_GONE_CONFIRM_MS apart.
//
// Fail safe: an unreadable listing, or a process of the provider whose working folder cannot be
// read, closes nothing and restarts the confirmation. A session with no known folder is never
// closed by process. Presence counts every listed process of the provider, a superset of its roots,
// so the error can only keep a session open. The listing is never identity (06 INV-51) and nothing
// here signals or ends a process.
//
// Cost: the listing is read only for sessions already quiet for PROCESS_GONE_QUIET_MS, at most once
// per PROCESS_LISTING_MAX_AGE_MS for all of them (one shared listing for every observed provider),
// and a read never waits for it: it uses the newest finished listing and asks for the next.
import { posix } from 'node:path'
import type { Clock } from '../../../../kernel/ports/clock'
import type { ProcessControl } from '../../../../kernel/ports/processControl'
import { canonicalRoot } from './fileIdentity'

/** How long a session must show no activity before its process is looked for (owner amendment I). */
export const PROCESS_GONE_QUIET_MS = 300_000

/** How far apart the two listings that both show no process must be (owner amendment I). */
export const PROCESS_GONE_CONFIRM_MS = 30_000

/** How long one listing serves every session (owner amendment I: "cache it about 15 s"). */
export const PROCESS_LISTING_MAX_AGE_MS = 15_000

/** One finished listing and the Host time it was asked for. */
export interface ProcessListingRead {
  takenAt: number
  rows: ReadonlyArray<{ stem: string; cwd: string | null }> | 'unreadable'
}

export interface SharedProcessListingDeps {
  processes: Pick<ProcessControl, 'listProcesses'>
  /** Every observed provider's stems: one listing serves them all. */
  stems: readonly string[]
  clock: Clock
  /** Defaults to PROCESS_LISTING_MAX_AGE_MS. */
  maxAgeMs?: number
}

/** One process listing shared by the observation adapters, never awaited by a read. */
export class SharedProcessListing {
  private last: ProcessListingRead | null = null
  private inFlight: Promise<void> | null = null

  constructor(private readonly deps: SharedProcessListingDeps) {}

  /**
   * The newest finished listing (null until one finished). When it is older than the max age and
   * none is in flight, the next one is asked for; this call does not wait for it.
   */
  latest(): ProcessListingRead | null {
    const now = this.deps.clock.now()
    const maxAge = this.deps.maxAgeMs ?? PROCESS_LISTING_MAX_AGE_MS
    if (this.inFlight === null && (this.last === null || now - this.last.takenAt >= maxAge)) {
      this.inFlight = this.deps.processes
        .listProcesses({ stems: this.deps.stems })
        .catch(() => 'unreadable' as const)
        .then((rows) => {
          this.last = { takenAt: now, rows }
        })
        .finally(() => {
          this.inFlight = null
        })
    }
    return this.last
  }

  /** Resolves once no listing is in flight (tests; drain). */
  async settled(): Promise<void> {
    while (this.inFlight !== null) await this.inFlight
  }
}

/**
 * The comparable form of a folder (owner amendment I: "paths are compared in normalized form"):
 * one separator, no trailing one, `.` and `..` resolved, and case folded where the OS folds it by
 * default (Windows, macOS). Folding can only make two folders one, which keeps a session open.
 */
export function folderKey(folder: string, platform: NodeJS.Platform): string {
  const separators = platform === 'win32' ? folder.replace(/\\/g, '/') : folder
  const normalized = posix.normalize(separators)
  const trimmed = normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized
  return platform === 'win32' || platform === 'darwin' ? trimmed.toLowerCase() : trimmed
}

export interface ProcessGoneWatchDeps {
  listing: SharedProcessListing
  /** This provider's stems: only its processes keep its sessions open. */
  stems: readonly string[]
  clock: Clock
  /** Whose folder rules apply; defaults to this Host's OS (R18: a module adapter may read it). */
  platform?: NodeJS.Platform
  /** A folder with every link followed (`realpath.native`); null when it cannot be resolved. */
  resolveFolder?: (folder: string) => Promise<string | null>
}

interface Watched {
  /** Host time of the session's last activity, or of its first sight this Host run. */
  lastActivity: number
  /** `takenAt` of the first listing of an unbroken run of listings that showed no process. */
  absentSince: number | null
  gone: boolean
}

/** The close-by-process state of one adapter's sessions, by a key the adapter chooses. */
export class ProcessGoneWatch {
  private readonly watched = new Map<string, Watched>()
  private readonly platform: NodeJS.Platform
  private readonly resolveFolder: (folder: string) => Promise<string | null>
  /** Resolved folder keys, kept for one listing. */
  private resolved: { takenAt: number; keys: Map<string, string> } | null = null

  constructor(private readonly deps: ProcessGoneWatchDeps) {
    this.platform = deps.platform ?? process.platform
    this.resolveFolder = deps.resolveFolder ?? canonicalRoot
  }

  /** The session showed activity now: the quiet gate and any confirmation start again. */
  active(key: string): void {
    this.watched.set(key, { lastActivity: this.deps.clock.now(), absentSince: null, gone: false })
  }

  /** Forgets a session (its stream went away). */
  forget(key: string): void {
    this.watched.delete(key)
  }

  /**
   * Whether the session's process is gone by the three conditions above. Once it is, it stays gone
   * until `active`. A session first seen now counts as active now.
   */
  async gone(key: string, folder: string | null): Promise<boolean> {
    const now = this.deps.clock.now()
    let watched = this.watched.get(key)
    if (watched === undefined) {
      watched = { lastActivity: now, absentSince: null, gone: false }
      this.watched.set(key, watched)
    }
    if (watched.gone) return true
    if (folder === null) return false
    if (now - watched.lastActivity < PROCESS_GONE_QUIET_MS) {
      watched.absentSince = null
      return false
    }
    const listing = this.deps.listing.latest()
    // Only a listing asked for after the session was already quiet says anything about it.
    if (listing === null || listing.takenAt < watched.lastActivity + PROCESS_GONE_QUIET_MS) {
      return false
    }
    if ((await this.presence(listing, folder)) !== 'absent') {
      watched.absentSince = null
      return false
    }
    watched.absentSince ??= listing.takenAt
    if (listing.takenAt - watched.absentSince >= PROCESS_GONE_CONFIRM_MS) watched.gone = true
    return watched.gone
  }

  private async presence(
    listing: ProcessListingRead,
    folder: string
  ): Promise<'present' | 'absent' | 'unknown'> {
    if (listing.rows === 'unreadable') return 'unknown'
    const own = listing.rows.filter((row) => this.deps.stems.includes(row.stem))
    if (own.some((row) => row.cwd === null)) return 'unknown'
    const target = await this.keyOf(listing, folder)
    for (const row of own) {
      if ((await this.keyOf(listing, row.cwd as string)) === target) return 'present'
    }
    return 'absent'
  }

  /** A folder's key with its links followed; a folder that cannot be resolved keeps its spelling. */
  private async keyOf(listing: ProcessListingRead, folder: string): Promise<string> {
    if (this.resolved?.takenAt !== listing.takenAt) {
      this.resolved = { takenAt: listing.takenAt, keys: new Map() }
    }
    const keys = this.resolved.keys
    const known = keys.get(folder)
    if (known !== undefined) return known
    const real = await this.resolveFolder(folder).catch(() => null)
    const key = folderKey(real ?? folder, this.platform)
    keys.set(folder, key)
    return key
  }
}
