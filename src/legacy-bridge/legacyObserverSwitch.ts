// Today's projects store without the observer's writes (ISSUE-123 introduced it as part of the cut-1 switch; 21 §2 cut 1
// "Switched off in legacy"; 21 §1 item 4): from cut 1 the Host observer is the single observer and the single writer of
// mines, dwarfs, messages, usage and ore (ADR-001 item 4.1), so today's observer stops being a writer.
//
// The cut-1 retirement (21 §2 cut 1 "Retired at the end"; OQ-71): ISSUE-124 removed today's poll timer, board publish,
// ledger crediting and projects-store board path from the composition, and ISSUE-125 today's notifier, whatever the
// route table, so nothing of today's observer is gated by a route table any more and cut 1 rolls forward only (21 §2.1
// item 4). What stays is this wrapper, which today's composition always applies (`LegacyRuntimeRoute.ts`).
//
// Today's poll tick still runs, driven by `LegacyAgentRegistryFeed`'s cycles (./LegacyRuntimeSurface.ts), because it is
// what keeps today's board, and with it the rows still `legacy` (send, console, stop, asks), current.
//
// Candidate decision (21 §6): today's composition (`LegacyRuntimeRoute.ts`) is KEPT; this wrapper is new code. Deleted
// with today's composition (cut 5).
import { mineIdForPath } from '../main/domain/aggregate'
import type { Platform } from '../main/platform/platform'
import { normalizeProjectName, projectNameForPath } from '../main/projects/projectName'
import type {
  ProjectObservation,
  ProjectRecord,
  ProjectsResult,
  ProjectsStore
} from '../main/projects/projectsStore'

/**
 * Today's projects store with the observer's writes switched off (from the cut-1 retirement, always): every read and every
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
