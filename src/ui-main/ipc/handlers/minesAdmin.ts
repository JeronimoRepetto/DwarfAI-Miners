// The Mines page's admin rows of seam A (14 §2.1, all KEEP: A-20 `openMinePath`, A-30 `declareMine`, A-31
// `declareMainProject`, A-32 `undeclareMine`, A-34 `queryProjects`): a route target of the router (ADR-001 item 3), so
// every call has passed the seam A gate first, sender and payload (ADR-019 items 7, 8). Each row keeps today's member
// name and answers today's shape (ADR-033 item 6), relayed through its Host method (21 §3.1: no shape adapter):
//
// - A-20 (split, 14 §1.10): `mines.resolveFile` (B-M20) resolves the renderer's mine-relative target inside the mine,
//   and main opens only the path the Host answered (`NativeActions.openPath`); the OS error text is never shown.
// - A-30 (split): main's folder picker produces the path (the renderer sends none), `mines.declare` (B-M16) settles it,
//   and a `{worktreeOf, mainPath}` answer is remembered per window, in memory only, for A-31; its `mainPath` is today's
//   `MineWorktreeOf.root` (owner amendment G, 2026-10-07).
// - A-31: `mines.adoptMainProject` (B-M17) with the path A-30 remembered for the calling window; it is spent once sent.
// - A-32: `mines.remove` (B-M18) through the injected `beforeRemoveMine` hook, which the root binds to
//   `LegacyEndFirstAdapter` (ISSUE-090, 21 §3) so a mine's legacy-launched sessions end first; the ONE danger toast of
//   a failed removal arrives as a Host frame.
// - A-34: `mines.list` (B-M19), its `MineSummaryWire` rows answered as today's `ProjectSummary` (14 §8 I-10).
//
// Every mutation mints its `requestId` in main, today's shapes having none (14 §1.6). With the Host not connected a row
// sends nothing and answers its legacy failure shape (ADR-002 D9); so does any call error (14 §1.5). Every reason is
// today's wording (`main/runtime/runtime.ts`, `main/shell/openMineFile.ts`), never an outcome code nor an OS text: today's
// renderer shows `reason` as it is. Nothing here logs: the payloads carry folder paths (14 §3.5).
//
// The rows keep their `legacy` route until the cut-1 switch (ISSUE-123) routes them here; the root composes this part
// only for a table that routes one of them `host`. A call of any other channel is refused, never guessed (14 §1.5).
//
// Candidate decision (21 §6): today's handlers (`LegacyRuntimeRoute`) are not candidates; replaced by these rows,
// written against the 14 §2.1 rows (evidence: minesAdmin.contract.test.ts and ipc-routing.contract.test.ts).
import type { z } from 'zod'
import {
  CHANNELS,
  MINE_LIST_MAX_LIMIT,
  type ChannelKey,
  type DwarfId,
  type FolderPath,
  type HostMethod,
  type IpcError,
  type MineId,
  type MineListParams,
  type MineSummaryWire
} from '@dwarfai/contracts'
import type { ServedNativeActions } from '../../window/application/nativeActions'
import type { HostClient } from '../../window/ports/hostClient'
import type { IpcSenderEvent } from '../senderCheck'
import type { RouteTarget } from '../router'

/** A-20 (invoke). */
export const MINE_OPEN_PATH = 'mine:openPath' satisfies ChannelKey
/** A-30 (invoke). */
export const MINE_DECLARE = 'mine:declare' satisfies ChannelKey
/** A-31 (invoke). */
export const MINE_DECLARE_MAIN = 'mine:declare-main' satisfies ChannelKey
/** A-32 (invoke). */
export const MINE_UNDECLARE = 'mine:undeclare' satisfies ChannelKey
/** A-34 (invoke). */
export const PROJECTS_QUERY = 'projects:query' satisfies ChannelKey
/** The rows this target serves. */
export const MINES_ADMIN_ROWS = [
  MINE_OPEN_PATH,
  MINE_DECLARE,
  MINE_DECLARE_MAIN,
  MINE_UNDECLARE,
  PROJECTS_QUERY
] as const

/** The seam B members each row uses (14 §2.1, §2.3), for the cut-1 switch's `HOST_ROUTE_MEMBERS` (ISSUE-123). */
export const MINES_ADMIN_MEMBERS: Readonly<
  Record<(typeof MINES_ADMIN_ROWS)[number], readonly HostMethod[]>
> = {
  [MINE_OPEN_PATH]: ['mines.resolveFile'],
  [MINE_DECLARE]: ['mines.declare'],
  [MINE_DECLARE_MAIN]: ['mines.adoptMainProject'],
  [MINE_UNDECLARE]: ['mines.remove'],
  [PROJECTS_QUERY]: ['mines.list']
}

type Request<K extends ChannelKey> = z.infer<(typeof CHANNELS)[K]['request']>
type Answer<K extends ChannelKey> = z.infer<(typeof CHANNELS)[K]['response']>
type OpenPathAnswer = Answer<typeof MINE_OPEN_PATH>
type DeclareAnswer = Answer<typeof MINE_DECLARE>
type QueryAnswer = Answer<typeof PROJECTS_QUERY>
type ProjectSummary = QueryAnswer['projects'][number]
/** Today's A-32 answer (14 §2.1 KEEP), from the channel registry. */
export type MineUndeclareAnswer = Answer<typeof MINE_UNDECLARE>

// Today's wording of each refusal (`main/shell/openMineFile.ts`, `main/runtime/runtime.ts`), unchanged.
const PATH_OUTSIDE = "That path is outside this mine's folder."
const PATH_MISSING = 'That file no longer exists.'
const PATH_UNOPENABLE = 'That file could not be opened.'
const PICKER_FAILED = 'The folder picker could not be opened.'
const DECLARE_FAILED = 'That folder could not be saved as a mine.'
const NO_PENDING_PROJECT = 'There is no project waiting to be opened. Add the folder again.'
const UNDECLARE_FAILED = 'That mine could not be removed.'
const NO_MINE_NAMED = 'No mine was named.'
const QUERY_FAILED = 'The projects could not be read.'
const NOT_A_QUERY = 'That is not a search this panel can run.'

/** B-M18's outcome code (14 §2.1 A-32), mapped to today's wording before it reaches the renderer. */
const DWARF_NOT_ENDED = 'dwarf-could-not-be-ended'

export interface MinesAdminDeps {
  client: Pick<HostClient, 'call' | 'state'>
  native: Pick<ServedNativeActions, 'chooseFolder' | 'openPath'>
  /** A UUIDv7 per mutation (14 §1.6; `host-client/requestIds.ts`). */
  newRequestId(): string
  /**
   * A-32's hook (21 §3 `LegacyEndFirstAdapter`): ends the mine's legacy-launched sessions first, then relays through
   * `remove`, or answers today's "unchanged" shape and relays nothing. A pass-through where the adapter does not live.
   */
  beforeRemoveMine(
    mineId: string,
    requestId: string,
    remove: (mineId: string, requestId: string) => Promise<MineUndeclareAnswer>
  ): Promise<MineUndeclareAnswer>
}

/** The window a call came from; a call main makes itself has none. */
const NO_WINDOW = -1
const windowOf = (sender: IpcSenderEvent | undefined): number => sender?.sender.id ?? NO_WINDOW

export function createMinesAdminRows(deps: MinesAdminDeps): RouteTarget {
  const { client, native, newRequestId } = deps
  /** The worktree each window's last A-30 picked, waiting for that window's A-31 (UI main memory, never persisted). */
  const remembered = new Map<number, string>()
  const connected = (): boolean => client.state().state === 'connected'

  async function openMinePath(payload: unknown): Promise<OpenPathAnswer> {
    const request = CHANNELS[MINE_OPEN_PATH].request.safeParse(payload)
    if (!request.success || !connected()) return { opened: false, reason: PATH_UNOPENABLE }
    const { mineId, target, dwarfId } = request.data
    try {
      const resolved = await client.call('mines.resolveFile', {
        mineId: mineId as MineId,
        target,
        ...(dwarfId === undefined ? {} : { dwarfId: dwarfId as DwarfId })
      })
      if (!resolved.ok) {
        return {
          opened: false,
          reason: resolved.error === 'escapes-mine' ? PATH_OUTSIDE : PATH_MISSING
        }
      }
      // Only the path the Host resolved inside the mine is opened, never the renderer's target (ADR-019 item 9).
      return await native.openPath(resolved.value.path)
    } catch {
      return { opened: false, reason: PATH_UNOPENABLE }
    }
  }

  async function declareMine(window: number): Promise<DeclareAnswer> {
    // A new Add supersedes the question an earlier one left for this window.
    remembered.delete(window)
    if (!connected()) return { outcome: 'failed', reason: DECLARE_FAILED }
    let folder: string | null
    try {
      folder = await native.chooseFolder()
    } catch {
      return { outcome: 'failed', reason: PICKER_FAILED }
    }
    if (folder === null) return { outcome: 'cancelled' }
    try {
      const declared = await client.call('mines.declare', {
        path: folder as FolderPath,
        requestId: newRequestId()
      })
      if (!declared.ok) return { outcome: 'failed', reason: DECLARE_FAILED }
      if ('mineId' in declared.value) return { outcome: 'added', mineId: declared.value.mineId }
      remembered.set(window, folder)
      return {
        outcome: 'worktree-of',
        // Amended: the root is the main working tree the Host named (owner amendment G, 2026-10-07).
        worktreeOf: { worktree: folder, root: declared.value.mainPath }
      }
    } catch {
      return { outcome: 'failed', reason: DECLARE_FAILED }
    }
  }

  async function declareMainProject(window: number): Promise<DeclareAnswer> {
    const worktreePath = remembered.get(window)
    if (worktreePath === undefined) return { outcome: 'failed', reason: NO_PENDING_PROJECT }
    if (!connected()) return { outcome: 'failed', reason: DECLARE_FAILED }
    // Spent once sent: the question it answered is closed whatever the Host says.
    remembered.delete(window)
    try {
      const adopted = await client.call('mines.adoptMainProject', {
        worktreePath: worktreePath as FolderPath,
        requestId: newRequestId()
      })
      return adopted.ok
        ? { outcome: 'added', mineId: adopted.value.mineId }
        : { outcome: 'failed', reason: DECLARE_FAILED }
    } catch {
      return { outcome: 'failed', reason: DECLARE_FAILED }
    }
  }

  async function remove(mineId: string, requestId: string): Promise<MineUndeclareAnswer> {
    try {
      const removed = await client.call('mines.remove', { mineId: mineId as MineId, requestId })
      return removed.ok
        ? { outcome: 'removed' }
        : { outcome: 'unchanged', reason: UNDECLARE_FAILED }
    } catch {
      return { outcome: 'failed', reason: UNDECLARE_FAILED }
    }
  }

  async function undeclareMine(payload: unknown): Promise<MineUndeclareAnswer> {
    const mineId = CHANNELS[MINE_UNDECLARE].request.safeParse(payload)
    if (!mineId.success || mineId.data === '')
      return { outcome: 'unchanged', reason: NO_MINE_NAMED }
    // Not connected: nothing is ended or sent, so no legacy session ends for a removal that cannot be relayed.
    if (!connected()) return { outcome: 'failed', reason: UNDECLARE_FAILED }
    const answer = await deps.beforeRemoveMine(mineId.data, newRequestId(), remove)
    // LegacyEndFirstAdapter answers the frozen outcome code as its reason (ISSUE-090): today's wording reaches the
    // renderer instead.
    return answer.reason === DWARF_NOT_ENDED ? { ...answer, reason: UNDECLARE_FAILED } : answer
  }

  async function queryProjects(payload: unknown): Promise<QueryAnswer> {
    const query = CHANNELS[PROJECTS_QUERY].request.safeParse(payload)
    if (!query.success) return { answered: false, projects: [], reason: NOT_A_QUERY }
    const params = listParamsOf(query.data)
    if (params === null) return { answered: false, projects: [], reason: NOT_A_QUERY }
    if (!connected()) return { answered: false, projects: [], reason: QUERY_FAILED }
    try {
      const page = await client.call('mines.list', params)
      return {
        answered: true,
        projects: page.mines.filter((mine) => !mine.removed).map(projectOf)
      }
    } catch {
      return { answered: false, projects: [], reason: QUERY_FAILED }
    }
  }

  return {
    async serve(channel, payload, sender) {
      switch (channel) {
        case MINE_OPEN_PATH:
          return openMinePath(payload)
        case MINE_DECLARE:
          return declareMine(windowOf(sender))
        case MINE_DECLARE_MAIN:
          return declareMainProject(windowOf(sender))
        case MINE_UNDECLARE:
          return undeclareMine(payload)
        case PROJECTS_QUERY:
          return queryProjects(payload)
        default: {
          const error: IpcError = {
            code: 'METHOD_NOT_FOUND',
            message: `no route for ${channel}`,
            retryable: false
          }
          return { ok: false, error }
        }
      }
    }
  }
}

/**
 * Today's `ProjectQuery` as `mines.list` params (14 §8 I-10): the field names are kept, the order is the one `MineQuery`
 * has for today's `lastOpenedAt` (`lastUsed`), and the page is clamped to what `mines.list` answers at once, as today's
 * main clamped it. Package gap: `addedAt` has no counterpart (`MineSummaryWire` carries no date a mine was added), so it
 * is `null`, a search this panel cannot run; today's renderer only asks by `lastOpenedAt`.
 */
function listParamsOf(query: Request<typeof PROJECTS_QUERY>): MineListParams | null {
  if (query.sortBy !== 'lastOpenedAt') return null
  const whole = (n: number): number => (Number.isFinite(n) ? Math.trunc(n) : 0)
  return {
    sortBy: 'lastUsed',
    direction: query.direction,
    ...(query.tier === undefined ? {} : { tier: query.tier }),
    ...(query.nameContains === undefined ? {} : { nameContains: query.nameContains }),
    ...(query.limit === undefined
      ? {}
      : { limit: Math.min(Math.max(whole(query.limit), 1), MINE_LIST_MAX_LIMIT) }),
    ...(query.offset === undefined ? {} : { offset: Math.max(whole(query.offset), 0) })
  }
}

/**
 * One `MineSummaryWire` as today's `ProjectSummary`, claiming only what the Host said. Package gap (14 is silent on the
 * fields the Host has no counterpart for): `addedAt` is 0, the renderer's own "no honest answer" value
 * (`lib/browse/boardRows.ts`); `declared` is false, so no "Measuring" pill is promised to a mine nobody said is being
 * measured; `folderMissing` and the weight are absent. `live` is a mine with a present dwarf.
 */
function projectOf(mine: MineSummaryWire): ProjectSummary {
  return {
    id: mine.mineId,
    path: mine.path,
    name: mine.name,
    declared: false,
    ...(mine.tier === null ? {} : { knownTier: mine.tier }),
    addedAt: 0,
    lastOpenedAt: mine.lastUsedAt,
    live: mine.presentDwarfs > 0
  }
}
