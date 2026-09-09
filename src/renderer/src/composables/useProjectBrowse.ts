import { ref } from 'vue'
import { declareFailureNotice } from '../lib/browse/addProject'
import type { BrowseFilters } from '../lib/browse/browseQuery'
import {
  defaultBrowseFilters,
  hasMorePages,
  projectQueryFor,
  toggledDirection
} from '../lib/browse/browseQuery'
import { removeFailureNotice } from '../lib/browse/removeMine'
import type { MineTier, MineWorktreeOf, ProjectSummary } from '../types'

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
 * Said when the removal channel itself could not be reached (#169).
 *
 * States that nothing was removed, which is the fact the user needs: the card
 * is still there, and a bridge that never answered removed nothing.
 */
const REMOVE_UNREACHABLE = 'The panel lost contact with the app. Nothing was removed.'

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
   * The worktree the person just picked, while the panel is asking whether to
   * open its project instead (#348), or null.
   *
   * Kept LOCAL to the browse, exactly as MinesPanel keeps which card is
   * awaiting its removal confirmation: it is a question on screen, and the only
   * thing that leaves is the answer. Cleared by either answer, so a cancel
   * leaves the list exactly as it was.
   */
  const worktreeQuestion = ref<MineWorktreeOf | null>(null)
  /**
   * Why the last adopt did not happen, or null.
   *
   * Kept apart from `error` because they are different facts: the list being
   * unreadable says nothing about a folder being refused, and one of them
   * appearing where the other belongs would misdescribe both.
   */
  const addError = ref<string | null>(null)
  /** True while main is carrying out a confirmed removal (#169). */
  const removing = ref(false)
  /**
   * Why the last removal did not happen, or null.
   *
   * Its own ref for the reason `addError` is one: the list being unreadable,
   * a folder being refused and a mine that would not go are three different
   * facts, and any of them appearing where another belongs misdescribes both.
   */
  const removeError = ref<string | null>(null)

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
   * folder the store already holds does not touch its last-activity date
   * (#205) — a folder nobody has worked in still has none — so it stays
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
      // A worktree is a QUESTION, not a refusal (#348): nothing was added and
      // nothing went wrong, so the dialog goes up and the list stays as it is
      // until the person answers.
      if (result.outcome === 'worktree-of') {
        worktreeQuestion.value = result.worktreeOf ?? null
        return
      }
      if (result.outcome !== 'added') return
      filters.value = defaultBrowseFilters()
      await load()
      const added = result.project
      if (added === undefined) return
      // Prepended rather than sorted in: the list is ordered by last activity
      // (#205), and re-declaring a folder does not touch its last-activity
      // date — this one was not worked in just now, it was re-declared. It
      // sits at the top because it is what the user just asked about, and the
      // next ordinary read puts it back in activity order, at the bottom if
      // it has never been opened.
      if (!projects.value.some((project) => project.id === added.id)) {
        projects.value = [added, ...projects.value]
      }
    } catch {
      addError.value = UNREACHABLE
    } finally {
      adding.value = false
    }
  }

  /**
   * Answer the worktree question by adopting the project instead (#348).
   *
   * Lands where a plain Add lands, and deliberately shares its whole tail: the
   * filters go back to their defaults and the new card is prepended when the
   * reload did not bring it, because the reasoning there — a re-declared folder
   * keeps the date it was first seen and can sit pages down — applies exactly
   * as much to a project adopted this way.
   *
   * The question is dismissed FIRST, whatever happens next. Main has already
   * forgotten the project by the time it answers, so a dialog left on screen
   * could only offer a button that no longer works.
   */
  async function openMainProject(): Promise<void> {
    if (adding.value) return
    worktreeQuestion.value = null
    adding.value = true
    addError.value = null
    try {
      const result = await window.api.declareMainProject()
      addError.value = declareFailureNotice(result)
      if (result.outcome !== 'added') return
      filters.value = defaultBrowseFilters()
      await load()
      const added = result.project
      if (added === undefined) return
      if (!projects.value.some((project) => project.id === added.id)) {
        projects.value = [added, ...projects.value]
      }
    } catch {
      addError.value = UNREACHABLE
    } finally {
      adding.value = false
    }
  }

  /** Dismiss the worktree question, having added nothing (#348). */
  function dismissWorktreeQuestion(): void {
    worktreeQuestion.value = null
  }

  /**
   * Remove a mine, by id (#169).
   *
   * The mine leaves the map, the list and the board, and nothing it mined is
   * lost — main flags the row rather than deleting it, so `addProject` on the
   * same folder brings the mine back with its ore. See MineUndeclareResult.
   *
   * The list is RELOADED on success and deliberately not on a refusal. On
   * success the page on screen is stale — the row it was read from is flagged
   * now — and the card going away is the only feedback a removal has. On a
   * refusal nothing changed, so re-reading would repaint the same list and make
   * a removal that did not happen look like one that did; the notice is what
   * says so instead.
   *
   * Filters are left exactly as they are, the opposite of `addProject`. That
   * one clears them because a new folder can fall outside them and a card the
   * user just made has to be visible; here the card is going away, and resetting
   * the browse would move the ground under a user who is in the middle of
   * tidying several mines under one filter.
   *
   * A second call while one is in flight is dropped: Confirm is destructive,
   * and a double press must not fire it twice. Resolves true exactly when main
   * reports the mine removed.
   */
  async function removeProject(projectId: string): Promise<boolean> {
    if (removing.value) return false
    removing.value = true
    removeError.value = null
    try {
      const result = await window.api.undeclareMine(projectId)
      removeError.value = removeFailureNotice(result)
      if (result.outcome !== 'removed') return false
      await load()
      return true
    } catch {
      removeError.value = REMOVE_UNREACHABLE
      return false
    } finally {
      removing.value = false
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
    removing,
    removeError,
    load,
    loadMore,
    setSearch,
    setTier,
    toggleDirection,
    addProject,
    worktreeQuestion,
    openMainProject,
    dismissWorktreeQuestion,
    removeProject
  }
}
