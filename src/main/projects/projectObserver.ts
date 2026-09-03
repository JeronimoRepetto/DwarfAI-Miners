import type { DwarfProvider, Mine, MineTier } from '../domain/types'
import type { ProjectRecord, ProjectsStore } from './projectsStore'

/**
 * Minimum gap between two writes for the SAME project.
 *
 * The poller ticks every two seconds (POLL_INTERVAL_MS defaults to 2000,
 * config.ts) and can be nudged more often than that, so an unthrottled observer
 * writes roughly 1,800 rows an hour for one project whose only moving field is
 * a recency stamp nobody sorts to the second. node:sqlite is synchronous, so
 * every one of those runs on the main thread the panel paints from.
 *
 * The same reasoning and the same window as the material ledger's
 * SAVE_INTERVAL_MS (materialLedger.ts:34), for the same reason: the in-memory
 * reading is the truth between writes and the exposure is bounded by this gap.
 * The one difference is what "dirty" means. The ledger writes its whole
 * document and can wait for a real change; last_opened_at changes by definition
 * on every poll, so waiting for a change would mean never writing at all. So
 * both rules apply: a fact that MATTERS — a first measured tier, a different
 * agent — is written the moment it is seen, and the stamp alone waits.
 */
export const PROJECT_OBSERVE_INTERVAL_MS = 30_000

export interface ProjectObserverOptions {
  store: ProjectsStore
  /**
   * The tier a walk has actually MEASURED for this mine — knownTierOf, never
   * tierOf. The column only ever takes a measurement (#41), and passing the
   * provisional bronze would fill a tier filter with projects nobody walked.
   */
  knownTierOf: (mine: Mine) => MineTier | undefined
  /** Where a refusal is reported; defaults to swallowing it. */
  onError?: (message: string, detail: unknown) => void
  /**
   * The row a write actually produced, reported once per successful write.
   *
   * It exists for one fact the caller cannot learn any other way: the store
   * chooses a project's map location DURING the write that creates it (#136),
   * so the poll loop's cache of placements would otherwise be a restart behind
   * for every newly discovered project — and the panel would draw that mine at
   * its own fallback position, then move it on the next launch.
   */
  onRecorded?: (record: ProjectRecord) => void
  intervalMs?: number
}

/** What was last written for one project, and when the attempt was made. */
interface LastWrite {
  at: number
  provider: DwarfProvider | undefined
  knownTier: MineTier | undefined
}

/**
 * Record every project a session is seen working in, as each poll publishes
 * (#93).
 *
 * A mine with NO working crew is never recorded, and that is the whole of the
 * rule that keeps "added" and "opened" apart: a project the user declared has
 * been added, not opened, and last_opened_at is what #92 sorts recency by. A
 * mine holding only 'leaving' dwarfs is not a sighting either — its agent has
 * already finished, and the mine was recorded while that agent was working.
 */
export class ProjectObserver {
  private readonly store: ProjectsStore
  private readonly knownTierOf: (mine: Mine) => MineTier | undefined
  private readonly onError: (message: string, detail: unknown) => void
  private readonly onRecorded: (record: ProjectRecord) => void
  private readonly intervalMs: number
  private readonly lastWrites = new Map<string, LastWrite>()

  constructor(options: ProjectObserverOptions) {
    this.store = options.store
    this.knownTierOf = options.knownTierOf
    this.onError = options.onError ?? (() => undefined)
    this.onRecorded = options.onRecorded ?? (() => undefined)
    this.intervalMs = options.intervalMs ?? PROJECT_OBSERVE_INTERVAL_MS
  }

  /**
   * Fold one published poll into the projects store.
   *
   * Never throws: this runs beside the loop that feeds the panel, and a
   * database that will not take a write must not stop the dwarfs from moving.
   */
  async observe(mines: readonly Mine[], now: number): Promise<void> {
    for (const mine of mines) {
      const provider = soleProviderOf(mine)
      const knownTier = this.knownTierOf(mine)
      // A walk is a MEASUREMENT and it is worth the same whether or not anybody
      // is in the mine (#156). The sighting rules below still refuse this mine —
      // it has not been opened — but its tier goes in, so the browse's SQL
      // filter classifies by the same walk the card's own label derives from.
      if (!isBeingWorked(mine)) {
        await this.measure(mine, knownTier)
        continue
      }
      if (!this.isDue(mine.id, now, provider, knownTier)) continue

      // Stamped BEFORE the write and left alone afterwards, refusal included.
      // A database that will not take this row will not take the next one two
      // seconds later either, so a failure has to consume its window exactly as
      // a success does; the alternative is a broken store being hammered — and
      // reported — on every poll for as long as it stays broken. Nothing is
      // lost by it: the next write inside the window carries the CURRENT facts,
      // so a measurement that missed its write is simply late, never dropped.
      this.lastWrites.set(mine.id, { at: now, provider, knownTier })
      try {
        const result = await this.store.upsertObserved({
          path: mine.path,
          at: now,
          ...(provider === undefined ? {} : { provider }),
          ...(knownTier === undefined ? {} : { knownTier })
        })
        if (result.ok) {
          this.onRecorded(result.value)
        } else {
          this.onError(
            `[projects] Could not record ${mine.name} (${result.failure}):`,
            result.message
          )
        }
      } catch (error) {
        this.onError(`[projects] Could not record ${mine.name}:`, error)
      }
    }
  }

  /**
   * Write the walk's verdict for a project nobody is working (#156).
   *
   * Throttled by the VERDICT rather than by the clock, which is the honest
   * window for this one: a measurement changes when a folder crosses a
   * threshold and at no other time, so "once per answer" is already at most a
   * handful of writes for the life of the process. The recency stamp is the
   * field that changes on every poll and it is not written here at all.
   *
   * The recorded write is remembered under `at: 0`, so a crew that later arrives
   * in this mine is recorded as a sighting on the very next poll instead of
   * waiting out a window it never spent.
   */
  private async measure(mine: Mine, knownTier: MineTier | undefined): Promise<void> {
    if (knownTier === undefined) return
    const last = this.lastWrites.get(mine.id)
    if (last !== undefined && last.knownTier === knownTier) return
    this.lastWrites.set(mine.id, { at: last?.at ?? 0, provider: last?.provider, knownTier })
    try {
      const result = await this.store.recordMeasuredTier({ path: mine.path, knownTier })
      if (!result.ok) {
        this.onError(
          `[projects] Could not measure ${mine.name} (${result.failure}):`,
          result.message
        )
      }
    } catch (error) {
      this.onError(`[projects] Could not measure ${mine.name}:`, error)
    }
  }

  /**
   * Whether this project is worth a write right now: one it has never made,
   * one whose recorded facts have moved, or one whose window has elapsed.
   */
  private isDue(
    mineId: string,
    now: number,
    provider: DwarfProvider | undefined,
    knownTier: MineTier | undefined
  ): boolean {
    const last = this.lastWrites.get(mineId)
    if (last === undefined) return true
    // A first measurement and a change of agent are the fields #92 filters and
    // labels by, so they never wait out the window that exists for a stamp.
    if (last.knownTier !== knownTier && knownTier !== undefined) return true
    if (last.provider !== provider && provider !== undefined) return true
    return now - last.at >= this.intervalMs
  }
}

/** A session is in there NOW — a grace-window departure is not a fresh sighting. */
function isBeingWorked(mine: Mine): boolean {
  return mine.dwarfs.some((dwarf) => dwarf.status !== 'leaving')
}

/**
 * The provider working this mine, when there is only one answer.
 *
 * "The last provider seen" has no answer for a project two different agents are
 * in at the same moment, and the store's COALESCE keeps the last unambiguous
 * one rather than accepting a coin flip. Reporting whichever dwarf happened to
 * be listed first would make the column flicker between the two.
 */
function soleProviderOf(mine: Mine): DwarfProvider | undefined {
  const providers = new Set(mine.dwarfs.map((dwarf) => dwarf.provider))
  return providers.size === 1 ? [...providers][0] : undefined
}
