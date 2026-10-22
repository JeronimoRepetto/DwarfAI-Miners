/*
 * A mine's history in use (#192, #279, #635; US-MINE-006): what the Host read for the mine (A-19 from its message log,
 * `useMineHistory`), read again while it is open whenever its crew says something, and what a click in it does — a
 * path opened against the mine's own folder, its refusal kept on the row that asked, a link relayed to main. Moved out
 * of `App.vue` for ISSUE-304 so a Valle zone draws the same history; the Panel's behaviour is unchanged.
 *
 * - `undefined` history means no answer has come back yet, which the panel says out loud rather than drawing as an
 *   empty mine. The previous answer stays on screen until the next lands, so a live update never flashes "reading"
 *   over a transcript somebody is reading; a slow answer for a mine the panel left never lands (the store's token).
 * - The store is the window's singleton by default (the Panel's one panel); a Valle zone hands its own
 *   (`createMineHistory`), so two zones never share one history.
 */
import type { MineId } from '@dwarfai/contracts'
import { computed, ref, watch } from 'vue'
import type { Mine, MineHistoryResult } from '../types'
import { historyAsToday, useMineHistory, type MineHistoryStore } from './useMineHistory'

export interface MineHistoryPageDeps {
  /** The mine whose history is asked for, or `null`. */
  mineId(): MineId | null
  /** That mine as the board draws it, for its crew and its folder; `undefined` when it has none. */
  mine(): Mine | undefined
  /** Whether the history is open now: closed, nothing is read and a read in flight cannot land. */
  open(): boolean
  /** The store it reads into; the window's singleton when not given. */
  store?: MineHistoryStore
}

export function useMineHistoryPage(deps: MineHistoryPageDeps) {
  const store = deps.store ?? useMineHistory()
  const history = computed<MineHistoryResult | undefined>(() => historyAsToday(store.state))

  /**
   * The refusal main gave for the LAST History path click (#279), keyed by the row so it can only ever land on the row
   * that was clicked. The panel has no status line of its own, so the refusal shows on the row itself.
   */
  const pathRefusal = ref<{ key: string; reason: string } | undefined>(undefined)

  /** An activity line's own path (#279), resolved and verified entirely in main, against the mine's own folder. */
  async function openPath(payload: { key: string; target: string }): Promise<void> {
    const mine = deps.mine()
    if (mine === undefined) return
    pathRefusal.value = undefined
    try {
      const result = await window.api.openMinePath({ mineId: mine.id, target: payload.target })
      if (!result.opened) pathRefusal.value = { key: payload.key, reason: result.reason }
    } catch {
      pathRefusal.value = { key: payload.key, reason: 'That file could not be opened.' }
    }
  }

  /** A link in a history message (#635): relayed to main, which validates it again and owns `shell.openExternal`. */
  async function openLink(href: string): Promise<void> {
    try {
      await window.api.openExternalLink(href)
    } catch {
      // The bridge is the only way out; nothing else can open it.
    }
  }

  /**
   * The signal the history re-reads on while open (#183, #192): every dwarf's `lastMessage` and
   * `transcriptUpdatedAt`, and a dwarf turning 'leaving' or dropping off the board, since its final words land with
   * its exit. One string, so an idle mine costs no read.
   */
  const crewSignal = computed(() =>
    (deps.mine()?.dwarfs ?? [])
      .map(
        (dwarf) =>
          `${dwarf.id}|${dwarf.lastMessage ?? ''}|${dwarf.transcriptUpdatedAt ?? ''}|${dwarf.status === 'leaving'}`
      )
      .join('\n')
  )

  watch(
    [deps.open, deps.mineId, crewSignal],
    ([open, mineId]) => {
      if (!open || mineId === null) {
        // Nothing to show: a read still in flight cannot land on a panel that has since closed or moved on.
        store.close()
        return
      }
      void store.open(mineId, window.api.getMineHistory)
    },
    { immediate: true }
  )

  return { history, pathRefusal, openPath, openLink }
}
