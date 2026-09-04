import { emptyMineForPath, samePathKey } from '../domain/aggregate'
import { PANEL_OBSERVER, type Dwarf, type Mine, type MineTier } from '../domain/types'
import { currentPlatform, type Platform } from '../platform/platform'
import type { HostedProcessState } from './hostedProcesses'

/**
 * Drawing the processes this panel is holding as dwarfs (#194).
 *
 * ## Why a stamp, and why this one is allowed to add a MINE
 *
 * The pattern is `stampHeldCrew`'s: a composed step that contributes dwarfs no
 * provider could see, folded in before the lifecycle runs so a departing one
 * gets the same leaving grace and walks out to a spawn point like anybody else.
 *
 * The difference is that this step may also have to contribute the mine. Every
 * other launch mode gets its mine for free — `aggregateMines` builds one from
 * the provider snapshot's `cwd`, which is the trick `docs/console-hosting.md`
 * calls "the whole trick": aggregation groups by folder, so the dwarf appears
 * in the mine it was launched from with no second observation path. A hosted
 * process has no snapshot, so there is no `cwd` to group. And the case is the
 * ordinary one rather than an edge: a mine nobody is working is not on the
 * board at all, its interior is not even mounted until the first agent arrives
 * (see MinesState.arrived), and launching that first agent is what Add is for.
 * A stamp that could only add to an existing mine would have reproduced #194's
 * freeze exactly — the panel waiting for an arrival that had already happened.
 *
 * The mine is built through `emptyMineForPath`, the same derivation
 * `mergeDeclaredMines` uses, so a hosted process's mine carries the id the
 * ledger and the projects store already know it by.
 *
 * ## What a hosted dwarf says, and the much longer list of what it does not
 *
 * It says: which mine it is in, that the panel observed it, that it is a root,
 * what program it is, that its process has not exited, and the exchange this
 * panel watched go by on its pipes. That is all, and the absences are the
 * honest half of #194's decision rather than work left undone — there is no
 * transcript behind this dwarf, so nothing could ever report a model, a token
 * count, a silence, an attendance, a blocked reason, an open question, an MCP
 * server or a cost for it. `Dwarf`'s own fields are optional for exactly this
 * kind of reason, and absent is what this app reads as unknown everywhere.
 *
 * The tier of a mine this creates is provisional, like any unwalked mine's:
 * `tierOf` always answers and is for DRAWING. Nothing here records a decision,
 * so `knownTierOf` is not what it asks — the ledger keeps that rule (#41).
 */

/** The tier of a project path, for drawing. Always answers; see #41 on why this one. */
export type MineTierLookup = (path: string) => MineTier

/**
 * The dwarf one hosted process is.
 *
 * `sessionId` is the hosted id, and that is not a placeholder: for a session
 * whose only observer is the holder, the holder's own id IS its identity. No
 * provider will ever match it, which is exactly right — every held-session
 * stamp downstream looks its session up and correctly finds nothing.
 *
 * `role` is `foreman` by construction, on launch.ts's own reasoning: "a run
 * with no parent is a root, and role is topology". So rank is not one of the
 * transcript-derived facts that go missing here, and no art has to be invented
 * — a hosted dwarf draws with the foreman sheets every session root draws with.
 *
 * `status` is `working` while the process is held, and it claims exactly that
 * much: this panel is holding a process that has not exited. Splitting it into
 * busy and idle would mean reading meaning out of rendered bytes — the
 * heuristic #60 refused and the reason docs/console-hosting.md turned down a
 * pty ("owning the bytes is not understanding them").
 */
function hostedDwarf(state: HostedProcessState): Dwarf {
  return {
    id: state.hostedId,
    provider: PANEL_OBSERVER,
    role: 'foreman',
    name: state.program,
    status: 'working',
    sessionId: state.hostedId,
    ...(state.conversation.length === 0 ? {} : { conversation: state.conversation })
  }
}

/**
 * Copy `mines` with a dwarf for every process this panel is holding, creating
 * the mine for one whose folder the board has no mine for.
 *
 * A process that has GONE contributes nothing — not a `leaving` dwarf, and not
 * an empty mine. The lifecycle tracker is what turns a dwarf's disappearance
 * from the snapshot into a departure with its grace window, and a second rule
 * here would be this stamp doing that job differently.
 *
 * Matched by PATH rather than by the mine id the launch remembered, through the
 * same normalization the board is grouped by: an id is a derived value, and a
 * hosted process must land in the mine that is actually there rather than
 * beside a second copy of it.
 */
export function stampHostedProcesses(
  mines: Mine[],
  states: readonly HostedProcessState[],
  tierOf: MineTierLookup,
  platform: Platform = currentPlatform()
): Mine[] {
  const running = states.filter((state) => state.running)
  if (running.length === 0) return mines

  const output = [...mines]
  const added = new Map<number, Dwarf[]>()
  for (const state of running) {
    let index = output.findIndex((mine) => samePathKey(mine.path, state.minePath, platform))
    if (index === -1) {
      index = output.length
      output.push(emptyMineForPath(state.minePath, tierOf(state.minePath), platform))
    }
    added.set(index, [...(added.get(index) ?? []), hostedDwarf(state)])
  }

  return output.map((mine, index) => {
    const dwarfs = added.get(index)
    return dwarfs === undefined ? mine : { ...mine, dwarfs: [...mine.dwarfs, ...dwarfs] }
  })
}
