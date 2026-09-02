import { ref } from 'vue'
import type { BrowseFilters } from '../lib/browse/browseQuery'
import {
  defaultBrowseFilters,
  hasMorePages,
  projectQueryFor,
  toggledDirection
} from '../lib/browse/browseQuery'
import type { MineTier, ProjectSummary } from '../types'

/**
 * What the panel says when a browse could not be read and main gave no reason.
 * A refusal always carries one over the wire, so this covers the bridge itself
 * failing — and it still has to say something, because silence would render as
 * "you have no projects".
 */
const UNREADABLE = 'DwarfAI-Miners could not read your projects.'

/**
 * The Mines panel's state (#92): the filters, the pages loaded so far, and
 * whether the last query was answered.
 *
 * Fresh refs per call rather than a module-scope singleton, like
 * usePinnedWindow: the panel is the only consumer, so per-call state keeps
 * tests independent without a clearAll() ritual.
 *
 * There is no debounce. The design filters in real time while the user types,
 * which means several queries are routinely in flight at once — so every
 * request is stamped and a stamp the panel has moved past is dropped rather
 * than rendered. Without that, a slow answer for "la" repaints the results of
 * "lal" with the wrong list.
 */
export function useProjectBrowse() {
  const filters = ref<BrowseFilters>(defaultBrowseFilters())
  const projects = ref<ProjectSummary[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)
  /** True once a page came back short: there is nothing behind it to ask for. */
  const exhausted = ref(false)

  let latest = 0

  async function run(offset: number): Promise<void> {
    const stamp = ++latest
    loading.value = true
    error.value = null
    if (offset === 0) exhausted.value = false
    try {
      const result = await window.api.queryProjects(projectQueryFor(filters.value, offset))
      if (stamp !== latest) return
      if (!result.answered) {
        // A refusal is not an empty list, and the pages already on screen were
        // read successfully — only the page that failed is missing.
        if (offset === 0) projects.value = []
        error.value = result.reason ?? UNREADABLE
        exhausted.value = true
        return
      }
      projects.value = offset === 0 ? result.projects : [...projects.value, ...result.projects]
      exhausted.value = !hasMorePages(result.projects.length)
    } catch {
      if (stamp !== latest) return
      error.value = UNREADABLE
      if (offset === 0) projects.value = []
      exhausted.value = true
    } finally {
      if (stamp === latest) loading.value = false
    }
  }

  /** Read the first page under the current filters, discarding anything loaded. */
  function load(): Promise<void> {
    return run(0)
  }

  /**
   * Read the page after the one on screen. Ignored while a page is in flight
   * and once the list is exhausted, so a scroll sentinel that fires repeatedly
   * asks for each page exactly once.
   */
  function loadMore(): Promise<void> {
    if (loading.value || exhausted.value) return Promise.resolve()
    return run(projects.value.length)
  }

  /** Every filter change restarts at the top: page 2 of the old filter is not page 2 of the new one. */
  function setSearch(search: string): Promise<void> {
    filters.value = { ...filters.value, search }
    return load()
  }

  function setTier(tier: MineTier | null): Promise<void> {
    filters.value = { ...filters.value, tier }
    return load()
  }

  function toggleDirection(): Promise<void> {
    filters.value = { ...filters.value, direction: toggledDirection(filters.value.direction) }
    return load()
  }

  return {
    filters,
    projects,
    loading,
    error,
    exhausted,
    load,
    loadMore,
    setSearch,
    setTier,
    toggleDirection
  }
}
