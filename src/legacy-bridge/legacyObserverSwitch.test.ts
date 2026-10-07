// layer: L1
import { describe, expect, it } from 'vitest'
import { MemoryWritableSqlite } from '../main/adapters/memoryWritableSqlite'
import { APP_DB_FILENAME } from '../main/appDatabase/appDatabase'
import { mineIdForPath } from '../main/domain/aggregate'
import { ProjectObserver } from '../main/projects/projectObserver'
import { createProjectsStore, type ProjectsStore } from '../main/projects/projectsStore'
import type { Mine } from '../main/domain/types'
import { legacyObserverComposition, withoutObserverWrites } from './legacyObserverSwitch'

const DECLARED = '/work/moria'
const SEEN = '/work/erebor'

function store(): ProjectsStore {
  return createProjectsStore({
    filePath: APP_DB_FILENAME,
    sqlite: new MemoryWritableSqlite(),
    platform: 'linux'
  })
}

/** Today's board with one working dwarf in each of `paths` (the fields the projects observer reads). */
function board(paths: readonly string[]): Mine[] {
  return paths.map(
    (path) =>
      ({
        id: mineIdForPath(path, 'linux'),
        path,
        name: path.split('/').pop() ?? path,
        tier: 'silver',
        dwarfs: [{ id: `claude:${path}`, provider: 'claude', status: 'working' }]
      }) as unknown as Mine
  )
}

describe('the cut-1 switch inside today’s runtime composition (21 §2 cut 1)', () => {
  it('[ADR-001] today’s observer sinks are composed exactly while today’s runtime observes', () => {
    expect(legacyObserverComposition('legacy')).toEqual({
      pollTimer: true,
      boardPublish: true,
      ledgerCrediting: true,
      projectsObserverWrites: true,
      notifier: true
    })
    expect(legacyObserverComposition('host')).toEqual({
      pollTimer: false,
      boardPublish: false,
      ledgerCrediting: false,
      projectsObserverWrites: false,
      notifier: false
    })
  })

  it('[ADR-001] with the observer’s writes switched off a poll writes nothing to today’s projects store and every read stays', async () => {
    const real = store()
    const declared = await real.declare({ path: DECLARED, at: 1 })
    expect(declared.ok).toBe(true)
    const before = await real.list()

    const errors: unknown[] = []
    const observer = new ProjectObserver({
      store: withoutObserverWrites(real, 'linux'),
      knownTierOf: () => 'silver',
      onError: (message) => void errors.push(message)
    })
    // A sighting of the declared mine and of a mine the store has never been shown, with measured tiers.
    await observer.observe(board([DECLARED, SEEN]), 10)
    await observer.observe(board([DECLARED, SEEN]), 100_000)

    expect(await real.list()).toEqual(before)
    expect(await real.get(mineIdForPath(SEEN, 'linux'))).toEqual({ ok: true, value: null })
    // Nothing refused, so nothing is reported on every poll.
    expect(errors).toEqual([])
    // Reads and the person's own acts pass through unchanged.
    const wrapped = withoutObserverWrites(real, 'linux')
    expect(await wrapped.list()).toEqual(before)
    expect((await wrapped.declare({ path: SEEN, at: 2 })).ok).toBe(true)
    expect((await real.get(mineIdForPath(SEEN, 'linux'))).ok).toBe(true)
  })
})
