import { describe, expect, it, vi } from 'vitest'
import { MemoryWritableSqlite } from '../adapters/memoryWritableSqlite'
import { defaultDwarf, defaultMine, type Dwarf, type Mine, type MineTier } from '../domain/types'
import { createProjectsStore, type ProjectsStore } from './projectsStore'
import { PROJECT_OBSERVE_INTERVAL_MS, ProjectObserver } from './projectObserver'

const DB = 'C:\\userData\\projects-v1.db'

function store(sqlite = new MemoryWritableSqlite()): ProjectsStore {
  return createProjectsStore({ filePath: DB, sqlite, platform: 'win32' })
}

function worker(overrides: Partial<Dwarf> = {}): Dwarf {
  return { ...defaultDwarf(), id: 'claude:s1', status: 'working', ...overrides }
}

function mine(overrides: Partial<Mine> = {}): Mine {
  return {
    ...defaultMine(),
    id: 'mine:c:\\x\\proj',
    path: 'C:\\X\\Proj',
    name: 'Proj',
    dwarfs: [worker()],
    ...overrides
  }
}

/** A tier that has actually been measured, unless a test says otherwise. */
const measured = (): MineTier | undefined => 'gold'
const unwalked = (): MineTier | undefined => undefined

describe('ProjectObserver', () => {
  it('records a project a session is being worked in', async () => {
    const projects = store()
    const observer = new ProjectObserver({ store: projects, knownTierOf: measured })

    await observer.observe([mine()], 1_000)

    const result = await projects.get('mine:c:\\x\\proj')
    expect(result.ok && result.value).toMatchObject({
      path: 'C:\\X\\Proj',
      name: 'Proj',
      lastOpenedAt: 1_000,
      lastProvider: 'claude',
      knownTier: 'gold',
      origin: 'discovered'
    })
  })

  it('records only a MEASURED tier, never the bronze a mine is merely drawn as', async () => {
    // tierOf's placeholder is indistinguishable from a real bronze (#41). A
    // filter for bronze projects would otherwise fill with ones nobody walked.
    const projects = store()
    const observer = new ProjectObserver({ store: projects, knownTierOf: unwalked })

    await observer.observe([mine({ tier: 'bronze' })], 1_000)

    const result = await projects.get('mine:c:\\x\\proj')
    expect(result.ok && result.value?.knownTier).toBeNull()
  })

  it('leaves a tier already measured alone when a later poll carries none', async () => {
    const projects = store()
    let tier: MineTier | undefined = 'silver'
    const observer = new ProjectObserver({ store: projects, knownTierOf: () => tier })

    await observer.observe([mine()], 1_000)
    tier = undefined
    await observer.observe([mine()], 1_000 + PROJECT_OBSERVE_INTERVAL_MS)

    const result = await projects.get('mine:c:\\x\\proj')
    expect(result.ok && result.value?.knownTier).toBe('silver')
  })

  it('never records a mine with no crew, because declaring one is not opening it', async () => {
    const projects = store()
    const observer = new ProjectObserver({ store: projects, knownTierOf: measured })

    await observer.observe([mine({ dwarfs: [], declared: true })], 1_000)

    const result = await projects.get('mine:c:\\x\\proj')
    expect(result.ok && result.value).toBeNull()
  })

  it('never records a mine whose only dwarfs are already walking out', async () => {
    // A 'leaving' dwarf's agent has finished; the mine it left was recorded
    // while it was working, and its grace window is not a fresh sighting.
    const projects = store()
    const observer = new ProjectObserver({ store: projects, knownTierOf: measured })

    await observer.observe([mine({ dwarfs: [worker({ status: 'leaving' })] })], 1_000)

    const result = await projects.get('mine:c:\\x\\proj')
    expect(result.ok && result.value).toBeNull()
  })

  it('records a project the user declared once a session actually works it', async () => {
    const projects = store()
    const observer = new ProjectObserver({ store: projects, knownTierOf: measured })

    await observer.observe([mine({ declared: true })], 1_000)

    const result = await projects.get('mine:c:\\x\\proj')
    expect(result.ok && result.value?.lastOpenedAt).toBe(1_000)
  })

  it('names no provider for a crew two different agents are sharing', async () => {
    // "The last provider seen" has no answer when two were seen at once, and
    // the store's COALESCE keeps the last unambiguous one rather than a guess.
    const projects = store()
    const observer = new ProjectObserver({ store: projects, knownTierOf: measured })

    await observer.observe([mine({ dwarfs: [worker({ id: 'a' })] })], 1_000)
    await observer.observe(
      [
        mine({
          dwarfs: [worker({ id: 'a' }), worker({ id: 'b', provider: 'codex' })]
        })
      ],
      1_000 + PROJECT_OBSERVE_INTERVAL_MS
    )

    const result = await projects.get('mine:c:\\x\\proj')
    expect(result.ok && result.value?.lastProvider).toBe('claude')
  })

  it('writes once per interval rather than once per poll', async () => {
    // The poller ticks every two seconds (POLL_INTERVAL_MS defaults to 2000),
    // so an unthrottled write is 1,800 rows an hour for one project whose only
    // moving field is a recency stamp nobody sorts to the second.
    const projects = store()
    const upsert = vi.spyOn(projects, 'upsertObserved')
    const observer = new ProjectObserver({ store: projects, knownTierOf: measured })

    await observer.observe([mine()], 1_000)
    await observer.observe([mine()], 3_000)
    await observer.observe([mine()], 5_000)

    expect(upsert).toHaveBeenCalledTimes(1)
  })

  it('writes again once the interval has elapsed', async () => {
    const projects = store()
    const upsert = vi.spyOn(projects, 'upsertObserved')
    const observer = new ProjectObserver({ store: projects, knownTierOf: measured })

    await observer.observe([mine()], 1_000)
    await observer.observe([mine()], 1_000 + PROJECT_OBSERVE_INTERVAL_MS)

    expect(upsert).toHaveBeenCalledTimes(2)
  })

  it('writes immediately inside the window when the first measurement arrives', async () => {
    // The throttle is there for a stamp nobody reads to the second. A tier is
    // the field #92 filters on, so it must not wait half a minute.
    const projects = store()
    let tier: MineTier | undefined = undefined
    const upsert = vi.spyOn(projects, 'upsertObserved')
    const observer = new ProjectObserver({ store: projects, knownTierOf: () => tier })

    await observer.observe([mine()], 1_000)
    tier = 'uranium'
    await observer.observe([mine()], 2_000)

    expect(upsert).toHaveBeenCalledTimes(2)
    const result = await projects.get('mine:c:\\x\\proj')
    expect(result.ok && result.value?.knownTier).toBe('uranium')
  })

  it('writes immediately inside the window when a different agent takes over', async () => {
    const projects = store()
    const upsert = vi.spyOn(projects, 'upsertObserved')
    const observer = new ProjectObserver({ store: projects, knownTierOf: measured })

    await observer.observe([mine()], 1_000)
    await observer.observe([mine({ dwarfs: [worker({ provider: 'codex' })] })], 2_000)

    expect(upsert).toHaveBeenCalledTimes(2)
  })

  it('reports a refusing store without retrying it every poll', async () => {
    const sqlite = new MemoryWritableSqlite()
    sqlite.failWith('locked')
    const projects = store(sqlite)
    const upsert = vi.spyOn(projects, 'upsertObserved')
    const onError = vi.fn()
    const observer = new ProjectObserver({ store: projects, knownTierOf: measured, onError })

    await observer.observe([mine()], 1_000)
    await observer.observe([mine()], 3_000)

    expect(onError).toHaveBeenCalledTimes(1)
    expect(upsert).toHaveBeenCalledTimes(1)
  })

  it('retries a refused write once the interval has elapsed', async () => {
    const sqlite = new MemoryWritableSqlite()
    sqlite.failWith('locked')
    const projects = store(sqlite)
    const observer = new ProjectObserver({ store: projects, knownTierOf: measured })

    await observer.observe([mine()], 1_000)
    sqlite.failWith(null)
    await observer.observe([mine()], 1_000 + PROJECT_OBSERVE_INTERVAL_MS)

    const result = await projects.get('mine:c:\\x\\proj')
    expect(result.ok && result.value?.lastOpenedAt).toBe(1_000 + PROJECT_OBSERVE_INTERVAL_MS)
  })

  it('throttles each project on its own clock', async () => {
    const projects = store()
    const upsert = vi.spyOn(projects, 'upsertObserved')
    const observer = new ProjectObserver({ store: projects, knownTierOf: measured })

    await observer.observe([mine()], 1_000)
    await observer.observe(
      [mine(), mine({ id: 'mine:c:\\x\\other', path: 'C:\\X\\Other', name: 'Other' })],
      2_000
    )

    expect(upsert).toHaveBeenCalledTimes(2)
  })
})

/**
 * Reporting the written row back to whoever is watching (#136).
 *
 * The map needs to know where a newly discovered project's mine was placed, and
 * the store is the only thing that knows — it chose the location during this
 * write. Without this the panel would draw that mine at its own fallback
 * position and then jump it to the persisted one on the next restart, which is
 * exactly the moving mine the design forbids.
 */
describe('ProjectObserver — reporting what it wrote', () => {
  it('hands back the row it just wrote, placement and all', async () => {
    const projects = store()
    const recorded: number[] = []
    const observer = new ProjectObserver({
      store: projects,
      knownTierOf: measured,
      onRecorded: (record) => {
        if (record.mapSite !== null) recorded.push(record.mapSite)
      }
    })

    await observer.observe([mine()], 1_000)

    expect(recorded).toHaveLength(1)
    const stored = await projects.get('mine:c:\\x\\proj')
    expect(stored.ok && stored.value?.mapSite).toBe(recorded[0])
  })

  it('reports nothing for a poll it decided not to write', async () => {
    const projects = store()
    let calls = 0
    const observer = new ProjectObserver({
      store: projects,
      knownTierOf: measured,
      onRecorded: () => {
        calls++
      }
    })

    await observer.observe([mine()], 1_000)
    await observer.observe([mine()], 1_500)

    expect(calls).toBe(1)
  })

  it('reports nothing when the write was refused', async () => {
    const sqlite = new MemoryWritableSqlite()
    const projects = store(sqlite)
    sqlite.failWith('locked')
    let calls = 0
    const observer = new ProjectObserver({
      store: projects,
      knownTierOf: measured,
      onRecorded: () => {
        calls++
      }
    })

    await observer.observe([mine()], 1_000)

    expect(calls).toBe(0)
  })
})

/*
 * A CREWLESS PROJECT IS STILL MEASURED (#156).
 *
 * The observer's rule — record only a mine somebody is working — is what keeps
 * "added" and "opened" apart, and it stays. What it must not also decide is
 * whether a MEASUREMENT is worth keeping: the walk weighed the folder either
 * way, the card already classifies from that weight, and the SQL tier filter
 * reads the column. Leaving the column NULL for every project nobody had opened
 * is what made the browse's Cropper filter miss the two cards saying Cropper.
 */
describe('ProjectObserver measuring a crewless project (#156)', () => {
  const declared = (overrides: Partial<Mine> = {}): Mine =>
    mine({ dwarfs: [], declared: true, ...overrides })

  it('records the tier a walk measured for a project nobody is working', async () => {
    const projects = store()
    await projects.declare({ path: 'C:\\X\\Proj', at: 500 })
    const observer = new ProjectObserver({ store: projects, knownTierOf: measured })

    await observer.observe([declared()], 1_000)

    const result = await projects.get('mine:c:\\x\\proj')
    expect(result.ok && result.value?.knownTier).toBe('gold')
  })

  it('does not call that an opening: declaring is still not working', async () => {
    const projects = store()
    await projects.declare({ path: 'C:\\X\\Proj', at: 500 })
    const observer = new ProjectObserver({ store: projects, knownTierOf: measured })

    await observer.observe([declared()], 1_000)

    const result = await projects.get('mine:c:\\x\\proj')
    expect(result.ok && result.value?.lastOpenedAt).toBeNull()
    expect(result.ok && result.value?.origin).toBe('declared')
  })

  it('writes nothing at all while the walk is still running', async () => {
    // #41 intact: the provisional bronze never reaches the column, whether or
    // not anybody is in the mine.
    const projects = store()
    await projects.declare({ path: 'C:\\X\\Proj', at: 500 })
    const observer = new ProjectObserver({ store: projects, knownTierOf: unwalked })

    await observer.observe([declared({ tier: 'bronze' })], 1_000)

    const result = await projects.get('mine:c:\\x\\proj')
    expect(result.ok && result.value?.knownTier).toBeNull()
  })

  it('brings a project the store has never seen into it no other way', async () => {
    // A simulated valley's mines are not folders on anybody's disk (#42), and a
    // measurement must not be a second door into the user's project list.
    const projects = store()
    const observer = new ProjectObserver({ store: projects, knownTierOf: measured })

    await observer.observe([declared()], 1_000)

    const listed = await projects.list()
    expect(listed.ok && listed.value).toEqual([])
  })

  it('writes once per verdict rather than once per poll', async () => {
    const projects = store()
    await projects.declare({ path: 'C:\\X\\Proj', at: 500 })
    const spy = vi.spyOn(projects, 'recordMeasuredTier')
    const observer = new ProjectObserver({ store: projects, knownTierOf: measured })

    await observer.observe([declared()], 1_000)
    await observer.observe([declared()], 3_000)
    await observer.observe([declared()], 5_000)

    expect(spy).toHaveBeenCalledOnce()
  })

  it('records the new verdict when a re-walk changes its mind', async () => {
    const projects = store()
    await projects.declare({ path: 'C:\\X\\Proj', at: 500 })
    let tier: MineTier = 'copper'
    const observer = new ProjectObserver({ store: projects, knownTierOf: () => tier })

    await observer.observe([declared()], 1_000)
    tier = 'gold'
    await observer.observe([declared()], 2_000)

    const result = await projects.get('mine:c:\\x\\proj')
    expect(result.ok && result.value?.knownTier).toBe('gold')
  })

  it('still refuses to record a mine whose whole crew is walking out', async () => {
    // A departure is not a sighting, and that is unchanged — but the walk still
    // measured the folder, so the tier is recorded and the stamp is not.
    const projects = store()
    await projects.declare({ path: 'C:\\X\\Proj', at: 500 })
    const observer = new ProjectObserver({ store: projects, knownTierOf: measured })

    await observer.observe([mine({ dwarfs: [worker({ status: 'leaving' })] })], 1_000)

    const result = await projects.get('mine:c:\\x\\proj')
    expect(result.ok && result.value?.lastOpenedAt).toBeNull()
    expect(result.ok && result.value?.knownTier).toBe('gold')
  })
})
