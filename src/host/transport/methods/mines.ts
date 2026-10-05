// B-M19 `mines.list` (14 §2.3, §3.4 `MineListParams`, `MineListResult`, `MineSummaryWire`, §8 I-10)
// over the mines module's `MinesQueries.list`. The composition root registers it (later:
// ISSUE-093); A-34 `queryProjects` relays it (later: ISSUE-091).
//
// - `ui` only (roles.ts): a `notifier` or `viewer` gets FORBIDDEN before the handler runs
//   (ADR-003 item 12).
// - Read-only: no requestId, no effect, no frame. The params are the contract's strict() schema
//   (INVALID_PARAMS otherwise, before the handler runs); their field names are today's
//   `ProjectQuery`'s.
// - The wire result is the port result mapped (14 §1.2): one `MineSummaryWire` per `MineSummary`.
//   `total` is how many mines the browse matches without its page: the frozen `MinesQueries.list`
//   (16 §4.1) answers a page only, so the handler reads the unpaged browse for it.
import { HOST_METHOD_SCHEMAS, type FolderPath, type HostMethods } from '@dwarfai/contracts'
import type { MineQuery, MinesQueries, MineSummary } from '../../modules/mines'
import type { Dispatcher } from '../dispatcher'
import { METHOD_ROLES } from '../roles'

export interface MinesMethodsDeps {
  mines: Pick<MinesQueries, 'list'>
}

/** Serves `mines.list` (B-M19) on `dispatcher`. */
export function registerMines(dispatcher: Dispatcher, deps: MinesMethodsDeps): void {
  dispatcher.register(
    'mines.list',
    HOST_METHOD_SCHEMAS['mines.list'].params,
    METHOD_ROLES['mines.list'] ?? [],
    (params): HostMethods['mines.list']['result'] => {
      const query = queryOf(params)
      const unpaged: MineQuery = { ...query }
      delete unpaged.limit
      delete unpaged.offset
      return {
        mines: deps.mines.list(query).map(toWire),
        total: deps.mines.list(unpaged).length
      }
    }
  )
}

/** The validated params as `MineQuery`, with every absent member left out. */
function queryOf(params: HostMethods['mines.list']['params']): MineQuery {
  return {
    sortBy: params.sortBy,
    direction: params.direction,
    ...(params.tier === undefined ? {} : { tier: params.tier }),
    ...(params.nameContains === undefined ? {} : { nameContains: params.nameContains }),
    ...(params.limit === undefined ? {} : { limit: params.limit }),
    ...(params.offset === undefined ? {} : { offset: params.offset })
  }
}

function toWire(summary: MineSummary): HostMethods['mines.list']['result']['mines'][number] {
  return {
    mineId: summary.mineId,
    name: summary.name,
    path: summary.path as string as FolderPath,
    tier: summary.tier,
    lastUsedAt: summary.lastUsedAt,
    presentDwarfs: summary.presentDwarfs,
    removed: summary.removed
  }
}
