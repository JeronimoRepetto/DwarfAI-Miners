import { createProjectsStore, type ProjectsStore, type ProjectsStoreOptions } from './projectsStore'

export type OpenProjectsStoreOptions = ProjectsStoreOptions & {
  /** Where the one refusal line goes; defaults to swallowing it. */
  warn?: (message: string) => void
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
): Promise<ProjectsStore | null> {
  const { warn, ...storeOptions } = options
  const store = createProjectsStore(storeOptions)
  const probe = await store.list()
  if (probe.ok) return store

  warn?.(
    `[projects] The projects database will not open (${probe.failure}): ${probe.message}. ` +
      'Mines you added will not be shown this run; discovered ones are unaffected.'
  )
  await store.close()
  return null
}
