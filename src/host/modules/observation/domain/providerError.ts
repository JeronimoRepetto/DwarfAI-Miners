// The provider errors the observer reports (ISSUE-084; 08 §0, §2.3 `ProviderErrorObserved`; 13
// FM-067, FM-068; US-RES-004). Pure: no I/O, no clock read (05 §2.2, R1).
//
// - A cause is one of four typed values, never the provider's own text (16 §2.1; ADR-026 item 4):
//   the original reaches the log only as an `errCode`.
// - One report per `(providerId, cause, dwarfId?)` and poll cycle (08 §2.3 idempotency; HO-33):
//   the loop opens each cycle with `beginCycle`, and a repeat within it is folded away.
// - Drift is counted before it surfaces (ADR-026 item 6; FM-068). A read that skipped records but
//   read nothing is one unreadable read of its key; `DRIFT_SURFACE_THRESHOLD` of them in a row
//   surface once as `unreadable` — the same toast as any provider error, worded no differently
//   (US-RES-004.AC04, PO #11). A read that read anything ends the streak; skipped lines beside
//   readable records stay a log record only (FM-086). A read with nothing new neither counts nor
//   ends the streak.
//
// Package gap (resolved in dev, ISSUE-084): the package names no threshold. Three unreadable reads
// in a row — three poll cycles, about six seconds at `OBSERVATION_POLL_MS` — tells a format change
// from one torn write, and a streak is told once: the person hears it again only after the
// provider was readable in between.
import type { DwarfId, ProviderId } from '../../../kernel/domain/values'

/**
 * The typed causes of an observed provider error (13 FM-067, FM-068): the kinds of 15 §3
 * `DriverErrorCause` the observer can see, without their `detail`, plus `unreadable` for drift.
 */
export const PROVIDER_ERROR_CAUSES = Object.freeze([
  'provider-error',
  'rate-limited',
  'auth-required',
  'unreadable'
] as const)

export type ProviderErrorCause = (typeof PROVIDER_ERROR_CAUSES)[number]

/** Unreadable reads in a row of one key before drift surfaces as `unreadable`. */
export const DRIFT_SURFACE_THRESHOLD = 3

/** One provider error, as `ProviderErrorObserved` carries it (08 §0). */
export interface ProviderErrorReport {
  providerId: ProviderId
  cause: ProviderErrorCause
  dwarfId?: DwarfId
}

/** Whose drift a read counts toward. */
export interface DriftKey {
  providerId: ProviderId
  dwarfId?: DwarfId
}

/** What one read of a stream gave. */
export interface ReadOutcome {
  /** It read at least one record. */
  readable: boolean
  /** It skipped at least one record, or the read itself failed. */
  drifted: boolean
}

interface Streak {
  count: number
  surfaced: boolean
}

export class ProviderErrorFold {
  /** The report keys already published in this poll cycle. */
  private readonly thisCycle = new Set<string>()
  private readonly streaks = new Map<string, Streak>()

  /** Opens a poll cycle: every key may report once more. */
  beginCycle(): void {
    this.thisCycle.clear()
  }

  /** The report to publish, or null when its key already reported in this cycle. */
  error(report: ProviderErrorReport): ProviderErrorReport | null {
    const key = JSON.stringify([report.providerId, report.cause, report.dwarfId ?? null])
    if (this.thisCycle.has(key)) return null
    this.thisCycle.add(key)
    return {
      providerId: report.providerId,
      cause: report.cause,
      ...(report.dwarfId === undefined ? {} : { dwarfId: report.dwarfId })
    }
  }

  /** Counts one read toward its key's drift; the `unreadable` report when the streak surfaces. */
  read(key: DriftKey, outcome: ReadOutcome): ProviderErrorReport | null {
    const id = JSON.stringify([key.providerId, key.dwarfId ?? null])
    if (outcome.readable) {
      this.streaks.delete(id)
      return null
    }
    if (!outcome.drifted) return null
    const streak = this.streaks.get(id) ?? { count: 0, surfaced: false }
    streak.count += 1
    this.streaks.set(id, streak)
    if (streak.surfaced || streak.count < DRIFT_SURFACE_THRESHOLD) return null
    streak.surfaced = true
    return this.error({ ...key, cause: 'unreadable' })
  }
}
