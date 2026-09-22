import {
  createProjectsStore,
  type ProjectsFailure,
  type ProjectsStore,
  type ProjectsStoreOptions
} from './projectsStore'

export type OpenProjectsStoreOptions = ProjectsStoreOptions & {
  /** Where the one refusal line goes; defaults to swallowing it. */
  warn?: (message: string) => void
}

/**
 * What opening the projects database found: a usable store, or the reason
 * there is none.
 *
 * Follows `openLedgerStore`'s `OpenedLedgerStore` shape (#93) rather than the
 * bare `ProjectsStore | null` this returned before #572: a null store used to
 * be the end of the story, but the classification behind it — corrupt, locked,
 * unsupported-schema, or a database a NEWER build wrote — has to survive past
 * this function's own log line so the runtime's four refusal sites can name
 * the one case with an actual fix instead of one sentence covering all of them.
 */
export interface OpenedProjectsStore {
  /** The usable store, or null when the database refused to open at all. */
  store: ProjectsStore | null
  /** Why `store` is null; null when it opened. */
  failure: ProjectsFailure | null
}

/**
 * Open the projects database, or say why it will not open — and never take the
 * panel down for either answer (#93).
 *
 * The store itself refuses loudly by design: a locked, corrupt or
 * unknown-schema database answers with an explicit failure rather than an empty
 * project list, because "no projects" is a truthful answer for a new install
 * and would otherwise tell the user their history is gone. That refusal has to
 * land SOMEWHERE, and startup is the only place that can turn it into a
 * degraded panel instead of a failed launch: everything the app does with live
 * sessions works without this file, so a broken projects database costs the
 * user their declared mines and nothing else.
 *
 * The read is a genuine probe, not a formality. createProjectsStore connects
 * lazily, so without it the first news of a corrupt file would arrive inside
 * whichever poll happened to touch it, long after the log line anyone would
 * read. list() also runs the schema check, so every way this database can be
 * unusable is discovered here, once, with the reason attached.
 */
export async function openProjectsStore(
  options: OpenProjectsStoreOptions
): Promise<OpenedProjectsStore> {
  const { warn, ...storeOptions } = options
  const store = createProjectsStore(storeOptions)
  const probe = await store.list()
  if (probe.ok) return { store, failure: null }

  warn?.(
    `[projects] The projects database will not open (${probe.failure}): ${probe.message}. ` +
      'Mines you added will not be shown this run; discovered ones are unaffected.'
  )
  await store.close()
  return { store: null, failure: probe.failure }
}
