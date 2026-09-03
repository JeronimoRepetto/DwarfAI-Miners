// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { BROWSE_PAGE_SIZE } from '../lib/browse/browseQuery'
import { defaultProject } from '../testing/factories'
import type { ProjectQueryResult, ProjectSummary } from '../types'
import { useProjectBrowse } from './useProjectBrowse'

/** An answered page of `count` distinct projects, numbered from `from`. */
function page(count: number, from = 0): ProjectQueryResult {
  const projects: ProjectSummary[] = Array.from({ length: count }, (_, index) =>
    defaultProject({ id: `p${from + index}`, name: `p${from + index}` })
  )
  return { answered: true, projects }
}

function stubQuery(queryProjects: unknown) {
  Object.defineProperty(window, 'api', { configurable: true, value: { queryProjects } })
}

/** Both halves of the browse surface, for the tests that adopt a folder (#85). */
function stubApi(api: { queryProjects?: unknown; declareMine?: unknown }) {
  Object.defineProperty(window, 'api', { configurable: true, value: api })
}

/** Resolves only when `release()` is called, so an in-flight page can be observed. */
function deferred<T>() {
  let release!: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

describe('useProjectBrowse first page', () => {
  it('asks for the newest projects, unfiltered, from the top', async () => {
    const queryProjects = vi.fn().mockResolvedValue(page(0))
    stubQuery(queryProjects)
    await useProjectBrowse().load()
    expect(queryProjects).toHaveBeenCalledWith({
      sortBy: 'addedAt',
      direction: 'desc',
      limit: BROWSE_PAGE_SIZE,
      offset: 0
    })
  })

  it('renders exactly the projects that were answered', async () => {
    stubQuery(vi.fn().mockResolvedValue(page(3)))
    const { projects, load } = useProjectBrowse()
    await load()
    expect(projects.value.map((project) => project.id)).toEqual(['p0', 'p1', 'p2'])
  })

  it('is not loading once the page has landed', async () => {
    stubQuery(vi.fn().mockResolvedValue(page(3)))
    const { loading, load } = useProjectBrowse()
    await load()
    expect(loading.value).toBe(false)
  })

  it('reports loading while the page is still in flight', async () => {
    const pending = deferred<ProjectQueryResult>()
    stubQuery(vi.fn().mockReturnValue(pending.promise))
    const { loading, load } = useProjectBrowse()
    const inFlight = load()
    expect(loading.value).toBe(true)
    pending.release(page(0))
    await inFlight
  })
})

describe('useProjectBrowse paging', () => {
  it('asks for the next page from where the loaded list ends', async () => {
    const queryProjects = vi
      .fn()
      .mockResolvedValueOnce(page(BROWSE_PAGE_SIZE))
      .mockResolvedValueOnce(page(BROWSE_PAGE_SIZE, BROWSE_PAGE_SIZE))
    stubQuery(queryProjects)
    const { load, loadMore } = useProjectBrowse()
    await load()
    await loadMore()
    expect(queryProjects).toHaveBeenLastCalledWith(
      expect.objectContaining({ offset: BROWSE_PAGE_SIZE })
    )
  })

  it('appends the next page rather than replacing the list', async () => {
    stubQuery(
      vi
        .fn()
        .mockResolvedValueOnce(page(BROWSE_PAGE_SIZE))
        .mockResolvedValueOnce(page(2, BROWSE_PAGE_SIZE))
    )
    const { projects, load, loadMore } = useProjectBrowse()
    await load()
    await loadMore()
    expect(projects.value).toHaveLength(BROWSE_PAGE_SIZE + 2)
    expect(projects.value.at(BROWSE_PAGE_SIZE)?.id).toBe(`p${BROWSE_PAGE_SIZE}`)
  })

  it('keeps paging while a page comes back full', async () => {
    stubQuery(vi.fn().mockResolvedValue(page(BROWSE_PAGE_SIZE)))
    const { exhausted, load } = useProjectBrowse()
    await load()
    expect(exhausted.value).toBe(false)
  })

  it('stops at the first short page', async () => {
    stubQuery(vi.fn().mockResolvedValue(page(BROWSE_PAGE_SIZE - 1)))
    const { exhausted, load } = useProjectBrowse()
    await load()
    expect(exhausted.value).toBe(true)
  })

  it('asks for nothing more once the list is exhausted', async () => {
    const queryProjects = vi.fn().mockResolvedValue(page(1))
    stubQuery(queryProjects)
    const { load, loadMore } = useProjectBrowse()
    await load()
    await loadMore()
    expect(queryProjects).toHaveBeenCalledTimes(1)
  })

  it('ignores a second scroll trigger while a page is still in flight', async () => {
    const pending = deferred<ProjectQueryResult>()
    const queryProjects = vi
      .fn()
      .mockResolvedValueOnce(page(BROWSE_PAGE_SIZE))
      .mockReturnValueOnce(pending.promise)
    stubQuery(queryProjects)
    const { load, loadMore } = useProjectBrowse()
    await load()
    const first = loadMore()
    await loadMore()
    expect(queryProjects).toHaveBeenCalledTimes(2)
    pending.release(page(0, BROWSE_PAGE_SIZE))
    await first
  })
})

describe('useProjectBrowse filters', () => {
  it('sends what was typed and starts again from the top', async () => {
    const queryProjects = vi.fn().mockResolvedValue(page(BROWSE_PAGE_SIZE))
    stubQuery(queryProjects)
    const { load, setSearch } = useProjectBrowse()
    await load()
    await setSearch('Café')
    expect(queryProjects).toHaveBeenLastCalledWith(
      expect.objectContaining({ nameContains: 'Café', offset: 0 })
    )
  })

  it('replaces the list on a filter change rather than appending to it', async () => {
    stubQuery(
      vi.fn().mockResolvedValueOnce(page(BROWSE_PAGE_SIZE)).mockResolvedValueOnce(page(1, 99))
    )
    const { projects, load, setSearch } = useProjectBrowse()
    await load()
    await setSearch('p99')
    expect(projects.value.map((project) => project.id)).toEqual(['p99'])
  })

  it('queries on every keystroke — the design filters in real time', async () => {
    const queryProjects = vi.fn().mockResolvedValue(page(0))
    stubQuery(queryProjects)
    const { setSearch } = useProjectBrowse()
    await setSearch('l')
    await setSearch('la')
    await setSearch('lal')
    expect(queryProjects).toHaveBeenCalledTimes(3)
  })

  it('filters by the chosen tier', async () => {
    const queryProjects = vi.fn().mockResolvedValue(page(0))
    stubQuery(queryProjects)
    const { setTier } = useProjectBrowse()
    await setTier('copper')
    expect(queryProjects).toHaveBeenLastCalledWith(expect.objectContaining({ tier: 'copper' }))
  })

  it('sends no tier at all for the All chip', async () => {
    const queryProjects = vi.fn().mockResolvedValue(page(0))
    stubQuery(queryProjects)
    const { setTier } = useProjectBrowse()
    await setTier('gold')
    await setTier(null)
    // Asserted as the WHOLE query, so an All chip that quietly sent a tier
    // key with an undefined value would still fail here.
    expect(queryProjects).toHaveBeenLastCalledWith({
      sortBy: 'addedAt',
      direction: 'desc',
      limit: BROWSE_PAGE_SIZE,
      offset: 0
    })
  })

  it('flips the date order and re-queries from the top', async () => {
    const queryProjects = vi.fn().mockResolvedValue(page(BROWSE_PAGE_SIZE))
    stubQuery(queryProjects)
    const { filters, load, toggleDirection } = useProjectBrowse()
    await load()
    await toggleDirection()
    expect(filters.value.direction).toBe('asc')
    expect(queryProjects).toHaveBeenLastCalledWith(
      expect.objectContaining({ direction: 'asc', offset: 0 })
    )
  })

  it('never lets a slower earlier answer overwrite a newer one', async () => {
    // Real-time search fires a query per keystroke, so two are routinely in
    // flight; the older one landing last must not repaint the older results.
    const slow = deferred<ProjectQueryResult>()
    stubQuery(
      vi
        .fn()
        .mockReturnValueOnce(slow.promise)
        .mockResolvedValueOnce({
          answered: true,
          projects: [defaultProject({ id: 'newest', name: 'newest' })]
        })
    )
    const { projects, setSearch } = useProjectBrowse()
    const stale = setSearch('la')
    await setSearch('lal')
    slow.release({ answered: true, projects: [defaultProject({ id: 'stale', name: 'stale' })] })
    await stale
    expect(projects.value.map((project) => project.id)).toEqual(['newest'])
  })
})

describe('useProjectBrowse failures', () => {
  it('shows a refusal as its reason, never as an empty list', async () => {
    // answered:false and "no projects yet" are both zero rows; reporting the
    // first as the second would tell the user their history is gone.
    stubQuery(
      vi.fn().mockResolvedValue({
        answered: false,
        projects: [],
        reason: 'The projects database could not be opened.'
      })
    )
    const { error, load } = useProjectBrowse()
    await load()
    expect(error.value).toBe('The projects database could not be opened.')
  })

  it('still says something when a refusal carries no reason', async () => {
    stubQuery(vi.fn().mockResolvedValue({ answered: false, projects: [] }))
    const { error, load } = useProjectBrowse()
    await load()
    expect(error.value).toBeTruthy()
  })

  it('stops paging after a refusal rather than hammering a closed door', async () => {
    const queryProjects = vi.fn().mockResolvedValue({ answered: false, projects: [], reason: 'no' })
    stubQuery(queryProjects)
    const { load, loadMore } = useProjectBrowse()
    await load()
    await loadMore()
    expect(queryProjects).toHaveBeenCalledTimes(1)
  })

  it('keeps the pages already loaded when a later page is refused', async () => {
    stubQuery(
      vi
        .fn()
        .mockResolvedValueOnce(page(BROWSE_PAGE_SIZE))
        .mockResolvedValueOnce({ answered: false, projects: [], reason: 'no' })
    )
    const { projects, error, load, loadMore } = useProjectBrowse()
    await load()
    await loadMore()
    expect(projects.value).toHaveLength(BROWSE_PAGE_SIZE)
    expect(error.value).toBe('no')
  })

  it('reports an unreachable bridge and stops loading', async () => {
    stubQuery(vi.fn().mockRejectedValue(new Error('bridge is gone')))
    const { error, loading, load } = useProjectBrowse()
    await load()
    expect(error.value).toBeTruthy()
    expect(loading.value).toBe(false)
  })

  it('clears a past failure once a query succeeds', async () => {
    stubQuery(
      vi.fn().mockRejectedValueOnce(new Error('bridge is gone')).mockResolvedValueOnce(page(1))
    )
    const { error, load, setSearch } = useProjectBrowse()
    await load()
    await setSearch('a')
    expect(error.value).toBeNull()
  })
})

/* Adopting a folder from the panel (#85, #127). */
describe('useProjectBrowse add project', () => {
  it('asks main to open the picker, naming no path', async () => {
    // The channel takes no payload on purpose: one that accepted a path would
    // be one that accepts any path.
    const declareMine = vi.fn().mockResolvedValue({ outcome: 'added', mineId: 'C:/dev/alpha' })
    stubApi({ queryProjects: vi.fn().mockResolvedValue(page(0)), declareMine })
    await useProjectBrowse().addProject()
    expect(declareMine).toHaveBeenCalledWith()
  })

  it('reads the list again from the top once a folder is adopted', async () => {
    const queryProjects = vi.fn().mockResolvedValue(page(BROWSE_PAGE_SIZE))
    stubApi({
      queryProjects,
      declareMine: vi.fn().mockResolvedValue({ outcome: 'added', mineId: 'C:/dev/alpha' })
    })
    const { load, loadMore, addProject } = useProjectBrowse()
    await load()
    await loadMore()
    await addProject()
    expect(queryProjects).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 0 }))
  })

  it('refreshes under the filters that are showing, not a fresh set', async () => {
    const queryProjects = vi.fn().mockResolvedValue(page(0))
    stubApi({
      queryProjects,
      declareMine: vi.fn().mockResolvedValue({ outcome: 'added', mineId: 'C:/dev/alpha' })
    })
    const { setTier, addProject } = useProjectBrowse()
    await setTier('gold')
    await addProject()
    expect(queryProjects).toHaveBeenLastCalledWith(expect.objectContaining({ tier: 'gold' }))
  })

  it('says nothing at all when the picker was closed without a choice', async () => {
    stubApi({
      queryProjects: vi.fn().mockResolvedValue(page(0)),
      declareMine: vi.fn().mockResolvedValue({ outcome: 'cancelled' })
    })
    const { addError, addProject } = useProjectBrowse()
    await addProject()
    expect(addError.value).toBeNull()
  })

  it('leaves the list alone when the picker was closed without a choice', async () => {
    const queryProjects = vi.fn().mockResolvedValue(page(0))
    stubApi({
      queryProjects,
      declareMine: vi.fn().mockResolvedValue({ outcome: 'cancelled' })
    })
    const { load, addProject } = useProjectBrowse()
    await load()
    await addProject()
    expect(queryProjects).toHaveBeenCalledTimes(1)
  })

  it('states why a folder could not be added, and does not reread the list', async () => {
    const queryProjects = vi.fn().mockResolvedValue(page(0))
    stubApi({
      queryProjects,
      declareMine: vi.fn().mockResolvedValue({
        outcome: 'failed',
        reason: 'That folder could not be saved as a mine.'
      })
    })
    const { addError, load, addProject } = useProjectBrowse()
    await load()
    await addProject()
    expect(addError.value).toBe('That folder could not be saved as a mine.')
    expect(queryProjects).toHaveBeenCalledTimes(1)
  })

  it('keeps a failed add apart from a browse that could not be read', async () => {
    // Two different facts: the list is fine and the folder was refused.
    stubApi({
      queryProjects: vi.fn().mockResolvedValue(page(2)),
      declareMine: vi.fn().mockResolvedValue({ outcome: 'failed', reason: 'refused' })
    })
    const { error, addError, projects, load, addProject } = useProjectBrowse()
    await load()
    await addProject()
    expect(error.value).toBeNull()
    expect(addError.value).toBe('refused')
    expect(projects.value).toHaveLength(2)
  })

  it('reports an unreachable bridge rather than looking like a cancel', async () => {
    stubApi({
      queryProjects: vi.fn().mockResolvedValue(page(0)),
      declareMine: vi.fn().mockRejectedValue(new Error('bridge is gone'))
    })
    const { addError, adding, addProject } = useProjectBrowse()
    await addProject()
    expect(addError.value).toBeTruthy()
    expect(adding.value).toBe(false)
  })

  it('is busy for as long as the picker is open', async () => {
    const pending = deferred<{ outcome: 'cancelled' }>()
    stubApi({
      queryProjects: vi.fn().mockResolvedValue(page(0)),
      declareMine: vi.fn().mockReturnValue(pending.promise)
    })
    const { adding, addProject } = useProjectBrowse()
    const inFlight = addProject()
    expect(adding.value).toBe(true)
    pending.release({ outcome: 'cancelled' })
    await inFlight
    expect(adding.value).toBe(false)
  })

  it('ignores a second press while the picker is still open', async () => {
    // The picker is modal in main; a second request would queue a second one
    // behind it for a click the user made before the first ever appeared.
    const pending = deferred<{ outcome: 'cancelled' }>()
    const declareMine = vi.fn().mockReturnValue(pending.promise)
    stubApi({ queryProjects: vi.fn().mockResolvedValue(page(0)), declareMine })
    const { addProject } = useProjectBrowse()
    const first = addProject()
    await addProject()
    expect(declareMine).toHaveBeenCalledTimes(1)
    pending.release({ outcome: 'cancelled' })
    await first
  })

  it('clears a past add failure when the next one is attempted', async () => {
    stubApi({
      queryProjects: vi.fn().mockResolvedValue(page(0)),
      declareMine: vi
        .fn()
        .mockResolvedValueOnce({ outcome: 'failed', reason: 'refused' })
        .mockResolvedValueOnce({ outcome: 'added', mineId: 'C:/dev/alpha' })
    })
    const { addError, addProject } = useProjectBrowse()
    await addProject()
    await addProject()
    expect(addError.value).toBeNull()
  })
})
