/*
 * The Mines page in use (#92, #169, #635; US-MINES-*): the browse over every project the app remembers, joined with the
 * board into cards, and what the page's own actions do — a refusal or a sort said in a toast, a removal confirmed and
 * said, and a mine just added opened as soon as it is on the board. Moved out of `App.vue` for ISSUE-304 so the Valle
 * window draws the same page from the same rules; the Panel's behaviour is unchanged.
 *
 * - The composable owns the browse (`useProjectBrowse`), and therefore its IPC (ADR-033 item 2): `MinesList` and
 *   `MapPage` stay presentational.
 * - Opening a mine is the window's own (`open`): the Panel opens its mine column; Valle adds its column to the mosaic or
 *   swaps it into the Work front.
 */
import { computed, ref, watch } from 'vue'
import { browseRows } from '../lib/browse/boardRows'
import { mineCardView, mineRefusalToast } from '../lib/browse/mineCard'
import { removedToast, sortToast, type MineSort } from '../lib/browse/minesList'
import type { Mine } from '../types'
import { useProjectBrowse } from './useProjectBrowse'
import { useToasts } from './useToasts'

export interface MinesPageDeps {
  /** Opens a mine in the window: the Panel's mine column, Valle's column or Work front. */
  open(mineId: string): void
  /** The board's mines (`useMines().state.mines`), read reactively. */
  mines(): readonly Mine[]
}

export function useMinesPage(deps: MinesPageDeps) {
  const browse = useProjectBrowse()
  const { showToast } = useToasts()

  /**
   * Every mine as its card, built once per change of the list or the board: the page filters and orders them itself,
   * so the board rows are joined unfiltered (lib/browse/boardRows.ts).
   */
  const mineCards = computed(() =>
    browseRows(browse.projects.value, deps.mines() as Mine[], { search: '', tier: null }).map(
      (row) => mineCardView(row, deps.mines() as Mine[])
    )
  )

  /**
   * A press on a mine that cannot be entered (PANEL-QUESTIONS 6): nothing opens, and a toast says why, "<name>:
   * <reason>", with the warning icon, from the Mines page and the map alike.
   */
  function refuse(projectId: string): void {
    const name =
      browse.projects.value.find((project) => project.id === projectId)?.name ?? projectId
    showToast(mineRefusalToast(name), 'warning')
  }

  function sort(mode: MineSort): void {
    browse.setSort(mode)
    showToast(sortToast(mode))
  }

  /**
   * Remove the mine a card asked about, once the Mines page has had it confirmed (#169), and say it happened ("<name>
   * removed", screens/browse.md). The board push that follows the removal lets go of a mine held open (#169).
   */
  async function remove(projectId: string): Promise<void> {
    const name =
      browse.projects.value.find((project) => project.id === projectId)?.name ?? projectId
    if (await browse.removeProject(projectId)) showToast(removedToast(name))
  }

  /**
   * The mine an add just made, until it is on the board (decision log, First run: add a mine: the folder picked
   * becomes the mine and opens at once). Main publishes the new mine on its next push, so a mine not on the board yet
   * opens as soon as it arrives; the page scrolls its card into view either way. Adding a mine never opens the Add
   * panel.
   */
  const pendingOpen = ref<string | null>(null)
  const reveal = ref<string | null>(null)

  function openAdded(mineId: string | undefined): void {
    if (mineId === undefined) return
    reveal.value = mineId
    if (deps.mines().some((mine) => mine.id === mineId)) deps.open(mineId)
    else pendingOpen.value = mineId
  }

  watch(deps.mines, (mines) => {
    const id = pendingOpen.value
    if (id === null || !mines.some((mine) => mine.id === id)) return
    pendingOpen.value = null
    deps.open(id)
  })

  async function add(): Promise<void> {
    openAdded(await browse.addProject())
  }

  async function adoptMainProject(): Promise<void> {
    openAdded(await browse.openMainProject())
  }

  return {
    filters: browse.filters,
    projects: browse.projects,
    loading: browse.loading,
    error: browse.error,
    adding: browse.adding,
    addError: browse.addError,
    removing: browse.removing,
    removeError: browse.removeError,
    worktreeQuestion: browse.worktreeQuestion,
    load: browse.load,
    refresh: browse.refresh,
    setSearch: browse.setSearch,
    setTier: browse.setTier,
    dismissWorktreeQuestion: browse.dismissWorktreeQuestion,
    mineCards,
    reveal,
    refuse,
    sort,
    remove,
    add,
    adoptMainProject
  }
}

export type MinesPage = ReturnType<typeof useMinesPage>
