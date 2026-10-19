// Installed detection (ADR-009 D5; 15 §1.3 row `detect()`; 15 §2.4): the one helper every driver's
// `detect()` and the catalogue's `launchable()` go through. It asks the one `InstallResolver`,
// caches each answer with the resolved path's `stat` mtime, and answers within the 500 ms budget:
//
// - a cached installed answer whose path still has the same mtime is answered as is, without
//   resolving again (no `--version` spawn); a changed mtime (an upgrade, FM-134) or a missing path
//   resolves again;
// - a cached not-installed or quarantined answer always resolves again, so a CLI installed (or
//   released from quarantine) later appears on the next Add-panel open (US-RES-005.AC04);
// - a check that has not answered within the budget keeps the last cached answer (not installed
//   when there is none: fail closed), and keeps running in the background; its answer refreshes the
//   cache for the next ask. Nothing is pushed (AMENDMENT-10: no frame).
//
// Never throws: a resolver failure is "not installed" (15 §1.3). Every timeout is a task on the
// injected Scheduler (16 §2.6). No provider id appears here (R12): detection is keyed by binaries.
import type { FileSystem } from '../../../kernel/ports/fileSystem'
import type { Scheduler } from '../../../kernel/ports/scheduler'
import type { ProviderId } from '../../../kernel/domain/values'
import type { InstallResolver } from '../ports/installResolver'
import type { DetectResult } from '../ports/providerDriver'

/** ADR-009 D5 (15 §0): the detection budget of one Add-panel open. */
export const DETECTION_BUDGET_MS = 500

/** What to detect: a provider's CLI, by its binary names (`ProviderProfile.binaries`). */
export interface DetectionNeed {
  readonly providerId: ProviderId
  readonly binaries: readonly string[]
}

export interface InstallDetection {
  /** Budgeted check of one CLI: the 15 §1.2 `DetectResult`. */
  detect(need: DetectionNeed): Promise<DetectResult>
  /** The last answer the cache holds for this need, or null when none was ever answered. */
  last(need: DetectionNeed): DetectResult | null
}

export interface InstallDetectionDeps {
  readonly resolver: InstallResolver
  readonly fs: Pick<FileSystem, 'stat'>
  readonly scheduler: Scheduler
}

const NOT_INSTALLED: DetectResult = Object.freeze({ kind: 'not-installed' })

export function createInstallDetection(deps: InstallDetectionDeps): InstallDetection {
  const cache = new Map<string, DetectResult>()
  const running = new Map<string, Promise<DetectResult>>()

  /** One full check; never rejects. */
  async function check(need: DetectionNeed, key: string): Promise<DetectResult> {
    try {
      const cached = cache.get(key)
      if (cached?.kind === 'installed') {
        const stat = await deps.fs.stat(cached.install.binaryPath)
        if (stat !== null && !stat.isDirectory && stat.mtimeMs === cached.install.statMtimeMs) {
          return cached
        }
      }
      const resolved = await deps.resolver.resolve(need.binaries)
      if (resolved === null) return NOT_INSTALLED
      // Resolved but never spawned (HR R2); treated as not installed (15 §1.2).
      if ('quarantined' in resolved) return { kind: 'quarantined', path: resolved.path }
      const stat = await deps.fs.stat(resolved.path)
      if (stat === null || stat.isDirectory) return NOT_INSTALLED
      return {
        kind: 'installed',
        install: {
          providerId: need.providerId,
          binaryPath: resolved.path,
          version: resolved.version ?? null,
          resolvedVia: resolved.resolvedVia,
          statMtimeMs: stat.mtimeMs
        }
      }
    } catch {
      return NOT_INSTALLED
    }
  }

  /** The check in flight for these binaries, or a new one; its answer always lands in the cache. */
  function rescan(need: DetectionNeed, key: string): Promise<DetectResult> {
    const inFlight = running.get(key)
    if (inFlight !== undefined) return inFlight
    const started = check(need, key).then((answer) => {
      cache.set(key, answer)
      running.delete(key)
      return answer
    })
    running.set(key, started)
    return started
  }

  return {
    async detect(need) {
      const key = keyOf(need)
      let timer: { cancel(): void } | undefined
      const budget = new Promise<null>((resolve) => {
        timer = deps.scheduler.after(DETECTION_BUDGET_MS, () => resolve(null))
      })
      const answer = await Promise.race([rescan(need, key), budget])
      timer?.cancel()
      return answer ?? cache.get(key) ?? NOT_INSTALLED
    },
    last(need) {
      return cache.get(keyOf(need)) ?? null
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
  need: DetectionNeed & { adapterBinaries?: readonly string[] }
): Promise<DetectResult> {
  const [cli, ...adapters] = await Promise.all([
    detection.detect(need),
    ...(need.adapterBinaries ?? []).map((adapter) =>
      detection.detect({ providerId: need.providerId, binaries: [adapter] })
    )
  ])
  if (cli === undefined) return NOT_INSTALLED
  if (cli.kind !== 'installed') return cli // not installed, or quarantined: reported as such
  return adapters.every((adapter) => adapter.kind === 'installed') ? cli : NOT_INSTALLED
}

function keyOf(need: DetectionNeed): string {
  return [need.providerId, ...need.binaries].join('\u0000')
}
