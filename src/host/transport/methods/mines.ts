// The mines rows of seam B (14 §2.3, §3.4) over the mines module: B-M16 `mines.declare` and B-M17
// `mines.adoptMainProject` over `MinesCommands`, B-M19 `mines.list` and B-M20 `mines.resolveFile`
// over `MinesQueries`. The composition root registers them (later: ISSUE-093); UI main's A-30,
// A-31, A-34 and A-20 relay them (later: ISSUE-091).
//
// - B-M16 and B-M17 are mutating (14 §1.6): a repeated `requestId` gets the first answer with no
//   second effect (dispatcher.ts, 16 §2.4), and the effect is committed before the answer (14 §1.7).
//   Their path comes from UI main's folder picker and is re-validated by the module (14 §1.10,
//   ADR-019 item 9): the wire checks only its shape.
// - B-M20 is a query: the module resolves the target inside the mine's folder on the real disk and
//   refuses an escape (18 C-17). Its optional `dwarfId` has no counterpart in the frozen
//   `resolveFileInMine` (16 §4.1), so it is accepted and not used (package gap).
//
// B-M19:
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
import type { MineQuery, MinesCommands, MinesQueries, MineSummary } from '../../modules/mines'
import type { Dispatcher } from '../dispatcher'
import { METHOD_ROLES } from '../roles'

export interface MinesMethodsDeps {
  mines: Pick<MinesQueries, 'list' | 'resolveFileInMine'>
  commands: Pick<MinesCommands, 'declare' | 'adoptMainProject'>
}

/** Serves B-M16, B-M17, B-M19 and B-M20 on `dispatcher`. */
export function registerMines(dispatcher: Dispatcher, deps: MinesMethodsDeps): void {
  dispatcher.registerMutating(
    'mines.declare',
    HOST_METHOD_SCHEMAS['mines.declare'].params,
    METHOD_ROLES['mines.declare'] ?? [],
    (params): Promise<HostMethods['mines.declare']['result']> => deps.commands.declare(params.path)
  )
  dispatcher.registerMutating(
    'mines.adoptMainProject',
    HOST_METHOD_SCHEMAS['mines.adoptMainProject'].params,
    METHOD_ROLES['mines.adoptMainProject'] ?? [],
    (params): Promise<HostMethods['mines.adoptMainProject']['result']> =>
      deps.commands.adoptMainProject(params.worktreePath)
  )
  dispatcher.register(
    'mines.resolveFile',
    HOST_METHOD_SCHEMAS['mines.resolveFile'].params,
    METHOD_ROLES['mines.resolveFile'] ?? [],
    (params): HostMethods['mines.resolveFile']['result'] => {
      const resolved = deps.mines.resolveFileInMine(params.mineId, params.target)
      return resolved.ok
        ? { ok: true, value: { path: resolved.value as string as FolderPath } }
        : resolved
    }
  )
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
