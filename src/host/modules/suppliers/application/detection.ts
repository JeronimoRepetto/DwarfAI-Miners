// Installed detection (ADR-009 D5; 15 §1.3 row `detect()`; 15 §2.4): the one helper every driver's
// `detect()` and the catalogue's `launchable()` go through. It asks the one `InstallResolver`,
// caches each answer with the resolved path's `stat` mtime, and answers within the 500 ms budget:
//
// - a cached installed answer whose path still has the same mtime is answered as is, without
//   resolving again (no `--version` spawn); a changed mtime (an upgrade, FM-134) or a missing path
//   resolves again;
// - a cached not-installed answer always resolves again, so a CLI installed later appears on the
//   next Add-panel open (US-RES-005.AC04);
// - a check that has not answered within the budget keeps the last cached answer (not installed
//   when there is none: fail closed), and keeps running in the background; its answer refreshes the
//   cache for the next ask. Nothing is pushed (AMENDMENT-10: no frame).
//
// Never throws: a resolver failure is "not installed" (15 §1.3). Every timeout is a task on the
// injected Scheduler (16 §2.6). No provider id appears here (R12): detection is keyed by binaries.
import type { FileSystem } from '../../../kernel/ports/fileSystem'
import type { Scheduler } from '../../../kernel/ports/scheduler'
import type { InstallResolver } from '../ports/installResolver'

/** ADR-009 D5 (15 §0): the detection budget of one Add-panel open. */
export const DETECTION_BUDGET_MS = 500

/**
 * What one detection found. The installed half carries the `InstalledProvider` fields the
 * resolver can answer (15 §1.2: `binaryPath` = `path`, `version`, `statMtimeMs`).
 */
export type Detection =
  | { kind: 'installed'; path: string; version: string | null; statMtimeMs: number }
  | { kind: 'not-installed' }

export interface InstallDetection {
  /** Budgeted check of one CLI, by its binary names (`ProviderProfile.binaries`). */
  detect(binaries: readonly string[]): Promise<Detection>
  /** The last answer the cache holds for these binaries, or null when none was ever answered. */
  last(binaries: readonly string[]): Detection | null
}

export interface InstallDetectionDeps {
  readonly resolver: InstallResolver
  readonly fs: Pick<FileSystem, 'stat'>
  readonly scheduler: Scheduler
}

const NOT_INSTALLED: Detection = Object.freeze({ kind: 'not-installed' })

export function createInstallDetection(deps: InstallDetectionDeps): InstallDetection {
  const cache = new Map<string, Detection>()
  const running = new Map<string, Promise<Detection>>()

  /** One full check; never rejects. */
  async function check(key: string, binaries: readonly string[]): Promise<Detection> {
    try {
      const cached = cache.get(key)
      if (cached?.kind === 'installed') {
        const stat = await deps.fs.stat(cached.path)
        if (stat !== null && !stat.isDirectory && stat.mtimeMs === cached.statMtimeMs) {
          return cached
        }
      }
      const resolved = await deps.resolver.resolve(binaries)
      if (resolved === null) return NOT_INSTALLED
      const stat = await deps.fs.stat(resolved.path)
      if (stat === null || stat.isDirectory) return NOT_INSTALLED
      return {
        kind: 'installed',
        path: resolved.path,
        version: resolved.version ?? null,
        statMtimeMs: stat.mtimeMs
      }
    } catch {
      return NOT_INSTALLED
    }
  }

  /** The check in flight for these binaries, or a new one; its answer always lands in the cache. */
  function rescan(key: string, binaries: readonly string[]): Promise<Detection> {
    const inFlight = running.get(key)
    if (inFlight !== undefined) return inFlight
    const started = check(key, binaries).then((answer) => {
      cache.set(key, answer)
      running.delete(key)
      return answer
    })
    running.set(key, started)
    return started
  }

  return {
    async detect(binaries) {
      const key = keyOf(binaries)
      let timer: { cancel(): void } | undefined
      const budget = new Promise<null>((resolve) => {
        timer = deps.scheduler.after(DETECTION_BUDGET_MS, () => resolve(null))
      })
      const answer = await Promise.race([rescan(key, binaries), budget])
      timer?.cancel()
      return answer ?? cache.get(key) ?? NOT_INSTALLED
    },
    last(binaries) {
      return cache.get(keyOf(binaries)) ?? null
    }
  }
}

/**
 * A driver's `detect()` (15 §2.4): its user's CLI must resolve, and so must every executable
 * adapter it needs that DwarfAI does not ship (ADR-009 D5 (a); `claude-agent-acp` always), each
 * through the same resolver. The answer names the user's CLI, never an adapter, and there is no
 * fallback to any bundled path (C-02, ADR-008 item 1).
 */
export async function detectForDriver(
  detection: InstallDetection,
  need: { binaries: readonly string[]; adapterBinaries?: readonly string[] }
): Promise<Detection> {
  const [cli, ...adapters] = await Promise.all([
    detection.detect(need.binaries),
    ...(need.adapterBinaries ?? []).map((adapter) => detection.detect([adapter]))
  ])
  if (cli === undefined || cli.kind !== 'installed') return NOT_INSTALLED
  return adapters.every((adapter) => adapter.kind === 'installed') ? cli : NOT_INSTALLED
}

function keyOf(binaries: readonly string[]): string {
  return binaries.join('\u0000')
}
