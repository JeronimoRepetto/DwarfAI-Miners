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
    expect(queryProjects.mock.calls[1][0].offset).toBe(BROWSE_PAGE_SIZE)
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
    expect(projects.value[BROWSE_PAGE_SIZE].id).toBe(`p${BROWSE_PAGE_SIZE}`)
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
    expect(queryProjects.mock.calls[1][0]).toMatchObject({ nameContains: 'Café', offset: 0 })
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
    expect(queryProjects.mock.calls[0][0].tier).toBe('copper')
  })

  it('sends no tier at all for the All chip', async () => {
    const queryProjects = vi.fn().mockResolvedValue(page(0))
    stubQuery(queryProjects)
    const { setTier } = useProjectBrowse()
    await setTier('gold')
    await setTier(null)
    expect('tier' in queryProjects.mock.calls[1][0]).toBe(false)
  })

  it('flips the date order and re-queries from the top', async () => {
    const queryProjects = vi.fn().mockResolvedValue(page(BROWSE_PAGE_SIZE))
    stubQuery(queryProjects)
    const { filters, load, toggleDirection } = useProjectBrowse()
    await load()
    await toggleDirection()
    expect(filters.value.direction).toBe('asc')
    expect(queryProjects.mock.calls[1][0]).toMatchObject({ direction: 'asc', offset: 0 })
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
