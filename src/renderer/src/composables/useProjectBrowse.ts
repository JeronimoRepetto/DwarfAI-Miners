import { ref } from 'vue'
import { declareFailureNotice } from '../lib/browse/addProject'
import type { BrowseFilters } from '../lib/browse/browseQuery'
import { defaultBrowseFilters, hasMorePages, projectQueryFor } from '../lib/browse/browseQuery'
import type { MineSort } from '../lib/browse/minesList'
import { removeFailureNotice } from '../lib/browse/removeMine'
import type { MineTier, MineWorktreeOf, ProjectSummary } from '../types'
import { useHostConnection } from './useHostConnection'

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
 * The Mines page's state (#92): the filters, every project main remembers, and whether the last
 * read was answered.
 *
 * Fresh refs per call rather than a module-scope singleton, like usePinnedWindow: the page is the
 * only consumer, so per-call state keeps tests independent without a clearAll() ritual.
 *
 * AMENDED for #635 (PR2): the redesigned page reads every project once and filters and orders
 * the cards itself (lib/browse/minesList.ts), so a search, a tier chip or a sort changes the
 * filters and asks main nothing; only a read does. A read goes through every page until a short
 * one, stamped, so a read the page has moved past is dropped rather than rendered — an older
 * answer landing last must not repaint older rows.
 */
export function useProjectBrowse() {
  const filters = ref<BrowseFilters>(defaultBrowseFilters())
  const projects = ref<ProjectSummary[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)
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

  /** At most this many pages per read: a store that never came back short cannot hang the page. */
  const MAX_PAGES = 100

  /**
   * Read every project, page after page until a short one. A refusal is not an empty list, and
   * the pages already read were read fine: only the page that failed is missing, and the reason
   * says so.
   */
  async function load(): Promise<void> {
    const stamp = ++latest
    loading.value = true
    error.value = null
    let read: ProjectSummary[] = []
    try {
      for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex++) {
        const result = await window.api.queryProjects(projectQueryFor(read.length))
        if (stamp !== latest) return
        if (!result.answered) {
          error.value = result.reason ?? UNREADABLE
          break
        }
        read = [...read, ...result.projects]
        if (!hasMorePages(result.projects.length)) break
      }
      projects.value = read
    } catch {
      if (stamp !== latest) return
      error.value = UNREADABLE
      projects.value = read
    } finally {
      if (stamp === latest) loading.value = false
    }
  }

  let refreshing: Promise<void> | null = null
  let refreshAgain = false

  /** Every page, or null when any page was refused or the bridge failed. */
  async function readAll(): Promise<ProjectSummary[] | null> {
    let read: ProjectSummary[] = []
    for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex++) {
      const result = await window.api.queryProjects(projectQueryFor(read.length))
      if (!result.answered) return null
      read = [...read, ...result.projects]
      if (!hasMorePages(result.projects.length)) break
    }
    return read
  }

  async function refreshOnce(): Promise<void> {
    const stamp = latest
    let read: ProjectSummary[] | null
    try {
      read = await readAll()
    } catch {
      read = null
    }
    // A read the person started meanwhile owns the list; a refused re-read changes nothing.
    if (read !== null && stamp === latest) projects.value = read
  }

  /**
   * Read the list again because what it shows changed on the board while it is on screen (#635,
   * lib/browse/browseRefresh.ts). Nobody asked for it, so it is quiet: no loading line, no
   * notice on a refusal (the rows already on screen stand), and the filters, and with them the
   * search, chip and order, are left exactly as they are. Cards keep their ids, so none enters
   * again. One runs at a time; whatever asks meanwhile gets one more read after it, never a queue.
   */
  function refresh(): Promise<void> {
    if (refreshing !== null) {
      refreshAgain = true
      return refreshing
    }
    refreshing = (async () => {
      try {
        do {
          refreshAgain = false
          await refreshOnce()
        } while (refreshAgain)
      } finally {
        refreshing = null
      }
    })()
    return refreshing
  }

  /** A search, a tier chip and a sort only change what the page shows: none asks main anything. */
  function setSearch(search: string): void {
    filters.value = { ...filters.value, search }
  }

  function setTier(tier: MineTier | null): void {
    filters.value = { ...filters.value, tier }
  }

  function setSort(sort: MineSort): void {
    filters.value = { ...filters.value, sort }
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
  async function addProject(): Promise<string | undefined> {
    // Read-only while the Host is not connected (ADR-002 D9; 13 FM-146): nothing leaves.
    if (useHostConnection().readOnly.value) return undefined
    if (adding.value) return undefined
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
        return undefined
      }
      if (result.outcome !== 'added') return undefined
      filters.value = defaultBrowseFilters()
      await load()
      const added = result.project
      if (added === undefined) return result.mineId
      // Prepended rather than sorted in: the list is ordered by last activity
      // (#205), and re-declaring a folder does not touch its last-activity
      // date — this one was not worked in just now, it was re-declared. It
      // sits at the top because it is what the user just asked about, and the
      // next ordinary read puts it back in activity order, at the bottom if
      // it has never been opened.
      if (!projects.value.some((project) => project.id === added.id)) {
        projects.value = [added, ...projects.value]
      }
      return result.mineId ?? added.id
    } catch {
      addError.value = UNREACHABLE
      return undefined
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
  async function openMainProject(): Promise<string | undefined> {
    // Read-only while the Host is not connected (ADR-002 D9; 13 FM-146): nothing leaves.
    if (useHostConnection().readOnly.value) return undefined
    if (adding.value) return undefined
    worktreeQuestion.value = null
    adding.value = true
    addError.value = null
    try {
      const result = await window.api.declareMainProject()
      addError.value = declareFailureNotice(result)
      if (result.outcome !== 'added') return undefined
      filters.value = defaultBrowseFilters()
      await load()
      const added = result.project
      if (added === undefined) return result.mineId
      if (!projects.value.some((project) => project.id === added.id)) {
        projects.value = [added, ...projects.value]
      }
      return result.mineId ?? added.id
    } catch {
      addError.value = UNREACHABLE
      return undefined
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
    // Read-only while the Host is not connected (ADR-002 D9; 13 FM-146): nothing leaves.
    if (useHostConnection().readOnly.value) return false
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
    adding,
    addError,
    removing,
    removeError,
    load,
    refresh,
    setSearch,
    setTier,
    setSort,
    addProject,
    worktreeQuestion,
    openMainProject,
    dismissWorktreeQuestion,
    removeProject
  }
}
