import { ref } from 'vue'
import { declareFailureNotice } from '../lib/browse/addProject'
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

/** Said when the declare channel itself could not be reached (#85). */
const UNREACHABLE = 'DwarfAI-Miners could not open the folder picker.'

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
  /** True while main is showing the folder picker (#85). */
  const adding = ref(false)
  /**
   * Why the last adopt did not happen, or null.
   *
   * Kept apart from `error` because they are different facts: the list being
   * unreadable says nothing about a folder being refused, and one of them
   * appearing where the other belongs would misdescribe both.
   */
  const addError = ref<string | null>(null)

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

  /**
   * Adopt a folder as a mine (#85).
   *
   * The request carries nothing: main owns the picker, so the renderer asks and
   * never names a path. A second press while the picker is open is dropped —
   * the picker is modal in main, and queueing another behind it would reopen it
   * for a click made before the first one ever appeared.
   *
   * ## Showing what was just added (#156)
   *
   * An Add that succeeds MUST show the card it just made. The maintainer added
   * a folder during the acceptance run and no card appeared, and the list was
   * behaving exactly as written: the reload kept the filters showing, a tier
   * chip was selected, and a folder nobody has walked has no measured tier — so
   * it matches no tier chip at all (see browseQuery.ts, "All is the only chip it
   * appears under"). The search box hides a new folder the same way.
   *
   * So the filters go back to their defaults. The add is the user's most recent
   * instruction; a filter they set a moment earlier is not a reason to hide the
   * thing they just asked for, and a button that reports success while the list
   * does not change is indistinguishable from one that is broken.
   *
   * Clearing the filters does not reach the other half of it: re-declaring a
   * folder the store already holds keeps the date it was first seen, so it stays
   * wherever it already sat and can be pages down. Main names the project it
   * adopted, and it goes to the head of the list when the reload did not bring
   * it. An older main that names none still reloads, and behaves as before.
   *
   * The map needs nothing from here: it picks the mine up on its next poll.
   */
  async function addProject(): Promise<void> {
    if (adding.value) return
    adding.value = true
    addError.value = null
    try {
      const result = await window.api.declareMine()
      // Null for an adopted folder AND for a closed picker: the list is the
      // feedback for the first, and backing out is not a fault to report.
      addError.value = declareFailureNotice(result)
      if (result.outcome !== 'added') return
      filters.value = defaultBrowseFilters()
      await load()
      const added = result.project
      if (added === undefined) return
      // Prepended rather than sorted in: the list is ordered by when a project
      // was ADDED, and this one was not added just now — it was re-declared. It
      // sits at the top because it is what the user just asked about, and the
      // next ordinary read puts it back in date order.
      if (!projects.value.some((project) => project.id === added.id)) {
        projects.value = [added, ...projects.value]
      }
    } catch {
      addError.value = UNREACHABLE
    } finally {
      adding.value = false
    }
  }

  return {
    filters,
    projects,
    loading,
    error,
    exhausted,
    adding,
    addError,
    load,
    loadMore,
    setSearch,
    setTier,
    toggleDirection,
    addProject
  }
}
