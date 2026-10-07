// The cut-1 switch inside today's runtime composition (ISSUE-123; 21 §2 cut 1 "Switched off in legacy"; 21 §1 item 4;
// AGENTS §5 "switched off at the switch"): from cut 1 the Host observer is the single observer and the single writer
// of mines, dwarfs, messages, usage and ore (ADR-001 item 4.1), so today's observer stops being a writer. What 21 §2
// lists as switched off is turned off here as a composition, gated by the route table (`legacyObserverOwner` in
// `src/ui-main/index.ts`), so a rollback build whose cut-1 rows route `legacy` again gets every part back (21 §2.1).
//
// The switch turns off the sinks, not the ticks: today's poll tick still runs, driven by `LegacyAgentRegistryFeed`'s
// cycles (./LegacyRuntimeSurface.ts), because it is what keeps today's board, and with it the rows still `legacy`
// (send, console, stop, asks), current. Its own timer is not started: the feed is the one tick driver.
//
// Candidate decision (21 §6): today's composition (`LegacyRuntimeRoute.ts`) is KEPT; this switch is new code that only
// selects which of today's parts it composes. Deleted with the composition code after the cut-1 soak (ISSUE-124,
// ISSUE-125).
import { mineIdForPath } from '../main/domain/aggregate'
import type { Platform } from '../main/platform/platform'
import { normalizeProjectName, projectNameForPath } from '../main/projects/projectName'
import type {
  ProjectObservation,
  ProjectRecord,
  ProjectsResult,
  ProjectsStore
} from '../main/projects/projectsStore'

/** Who observes the providers and writes what is observed: today's runtime, or the Host (from cut 1). */
export type LegacyObserverOwner = 'legacy' | 'host'

/** The parts of today's observer that write, each composed or switched off (21 §2 cut 1 "Switched off in legacy"). */
export interface LegacyObserverComposition {
  /** Today's poll timer (`runtime.start()`): off from cut 1, where the registry feed's cycles are the ticks. */
  pollTimer: boolean
  /** Today's poller → `publishGate` → board path: the A-P2 `minesUpdated` push of today's board. */
  boardPublish: boolean
  /** Today's ledger crediting: the vault store (`openLedgerStore`) and the historical coal backfill. */
  ledgerCrediting: boolean
  /** Today's projects store as the board's source: what the poll observes is written into it. */
  projectsObserverWrites: boolean
  /** Today's notifier (`notifyDecision` → Electron `Notification`). */
  notifier: boolean
}

/** What today's composition composes of its observer for `owner` (the Host from cut 1, today's runtime before). */
export function legacyObserverComposition(owner: LegacyObserverOwner): LegacyObserverComposition {
  const composed = owner === 'legacy'
  return {
    pollTimer: composed,
    boardPublish: composed,
    ledgerCrediting: composed,
    projectsObserverWrites: composed,
    notifier: composed
  }
}

/**
 * Today's projects store with the observer's writes switched off (`projectsObserverWrites: false`): every read and every
 * person's own act stay as they are, while a sighting (`upsertObserved`) and a walk's measurement (`recordMeasuredTier`)
 * write nothing. Each answers what the store holds for that path, read, never written: the row when there is one; for
 * a measurement, `null` for a path the store has never been shown (its own contract); for a sighting of a path it
 * has never been shown, the sighting as an unplaced row (no map site), which no one stores. The observer then treats
 * the poll as recorded and does not ask again inside its window, so it neither retries nor reports a refusal.
 */
export function withoutObserverWrites(store: ProjectsStore, platform: Platform): ProjectsStore {
  const held = (path: string): Promise<ProjectsResult<ProjectRecord | null>> =>
    store.get(mineIdForPath(path, platform))
  return {
    declare: (declaration) => store.declare(declaration),
    async upsertObserved(observation) {
      const row = await held(observation.path)
      if (!row.ok) return row
      return { ok: true, value: row.value ?? unstoredSighting(observation, platform) }
    },
    recordMeasuredTier: (measurement) => held(measurement.path),
    forget: (request) => store.forget(request),
    get: (id) => store.get(id),
    list: () => store.list(),
    query: (query) => store.query(query),
    close: () => store.close()
  }
}

/** A sighting of a path the store has never been shown, as the row it would have created: nothing stores it. */
function unstoredSighting(observation: ProjectObservation, platform: Platform): ProjectRecord {
  const name = projectNameForPath(observation.path)
  return {
    id: mineIdForPath(observation.path, platform),
    path: observation.path,
    name,
    nameNorm: normalizeProjectName(name),
    addedAt: observation.at,
    lastOpenedAt: observation.at,
    origin: 'discovered',
    lastProvider: observation.provider ?? null,
    knownTier: observation.knownTier ?? null,
    mapSite: null,
    hiddenAt: null
  }
}
