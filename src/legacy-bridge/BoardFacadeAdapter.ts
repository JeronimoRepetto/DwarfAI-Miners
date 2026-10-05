// `BoardFacadeAdapter` (21 §3, cuts 1–4; 14 §5): A-12 `getMines` and A-P2 `onMinesUpdated` (RETIRE rows of 14 §2.1)
// served from the Host board, in today's `MinesSnapshot` shape, so the composables that still read them keep working
// while the renderer switches to A-N01/A-N02 one composable at a time (ADR-001 item 2: member names and result shapes
// unchanged, `lib/**` and components untouched).
//
// - It reads the Host only through `HostClient.subscribe` (ADR-003 item 7: subscribe first, then the snapshot; one
//   `seq`). The client hands on a whole snapshot, then each frame newer than the last one applied, and handles a
//   `resync-required` itself: it reads a new snapshot and drops the frames it already reflects (seq ≤ S; 14 §4.3;
//   window/ports/hostClient.ts `HostEvent`). So every `snapshot` event replaces the board whole — never merged, nothing
//   inferred from a difference (14 §4.3 rule 6) — and every `frame` event is applied on top of it.
// - The board it keeps is the `mines` and `dwarfs` sections (14 §3.7, §4.1) and the frames `mine.changed`,
//   `dwarf.arrived`, `dwarf.changed`, `dwarf.departed` (14 §3.5). Material totals travel in `MineWire.totals`, in the
//   snapshot and in `mine.changed`; `mine.removed` and `ledger.changed` are folded here once their catalog entries land
//   in `contracts/host-protocol/frames.ts` (14 §3.5 B-F07, B-F20; later issues).
// - The fold to today's shape: Host ids (from cut 1 the renderer knows only those, 14 §5 `LegacyDwarfIdBridge`);
//   `materials` are each material's credited tokens (today's unit is tokens, `MaterialTotals`); a mine's
//   `tokensObserved` is the sum of its materials and the board's the sum of its mines', and the board's `materials` is
//   the sum over the mines the Host shows (the Host has no vault section, 14 §4.1). A mine not measured yet
//   (`tier: null`, 06 INV-05) shows today's default tier, `bronze`. A dwarf shows `leaving` while it walks out,
//   `working` while it works, else `waiting` (today's three states); a dwarf of a provider today's board has no
//   identity for, or of a mine not on the board, is left out (today's board could never show it).
// - A-P2 pushes the whole board after each change, at most once per macrotask (14 §1.8): the changes of one macrotask
//   are pushed together when the next one runs.
// - The ask fields of today's dwarf come from `askFields`, which `LegacyAskRelay` fills (later: ISSUE-089); `refresh`
//   pushes the board again when they change.
//
// Read-only: it never sends a Host command (21 §3; 14 §5). Composed only by `src/ui-main/index.ts` (R16); deleted at
// cut 5 after a test proves no consumer (ISSUE-242).
import type {
  DwarfId,
  DwarfWire,
  EvtFrame,
  HostFrames,
  Material,
  MaterialAmount,
  MineId,
  MineWire,
  SnapshotPage
} from '@dwarfai/contracts'
import {
  DWARF_PROVIDERS,
  type Dwarf,
  type DwarfProvider,
  type MaterialTotals,
  type Mine,
  type MinesSnapshot
} from '../shared/contracts'
import type { HostClient } from '../ui-main/window/ports/hostClient'

/** Today's ask fields of a dwarf, which `LegacyAskRelay` supplies (later: ISSUE-089). */
export type LegacyAskFields = Partial<
  Pick<Dwarf, 'pendingQuestion' | 'pendingPermission' | 'waitingReason'>
>

export interface BoardFacadeDeps {
  /** The one HostClient member the facade reads (ADR-003 item 7). */
  client: Pick<HostClient, 'subscribe'>
  /** A-P2: the whole board after a change. */
  push(board: MinesSnapshot): void
  /** Runs `run` in the next macrotask; production uses `setImmediate`. */
  defer?: (run: () => void) => void
  /** Today's ask fields of a dwarf (later: ISSUE-089); none when absent. */
  askFields?: (dwarfId: DwarfId) => LegacyAskFields
}

export interface BoardFacade {
  /** A-12: the board now. */
  getMines(): MinesSnapshot
  /** Pushes the board again in the next macrotask (the ask fields changed). */
  refresh(): void
  /** Unsubscribes; nothing is pushed after. */
  dispose(): void
}

const MATERIALS: readonly Material[] = ['coal', 'bronze', 'copper', 'silver', 'gold', 'uranium']

/** Today's default tier of a mine not measured yet (`defaultMine()` of the found tree). */
const UNMEASURED_TIER: Mine['tier'] = 'bronze'

const LEGACY_PROVIDERS: ReadonlySet<string> = new Set(DWARF_PROVIDERS)

function materialsOf(totals: Record<Material, MaterialAmount>): MaterialTotals {
  const materials = {} as MaterialTotals
  for (const material of MATERIALS) materials[material] = totals[material].tokens
  return materials
}

function sumOf(materials: MaterialTotals): number {
  return MATERIALS.reduce((sum, material) => sum + materials[material], 0)
}

function statusOf(dwarf: DwarfWire): Dwarf['status'] {
  if (dwarf.presence === 'walking-out') return 'leaving'
  return dwarf.status === 'working' ? 'working' : 'waiting'
}

function toLegacyDwarf(dwarf: DwarfWire, asks: LegacyAskFields): Dwarf {
  const { model, effort } = dwarf.sessionProfile
  return {
    id: dwarf.id,
    provider: dwarf.providerId as DwarfProvider,
    role: dwarf.rank,
    name: dwarf.baseName,
    ...(dwarf.customName === null ? {} : { customName: dwarf.customName }),
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    status: statusOf(dwarf),
    ...(dwarf.parentDwarfId === null ? {} : { parentId: dwarf.parentDwarfId }),
    // Today's board names a dwarf's session; the Host's id stands in for it (ADR-015: the provider's ids stay apart).
    sessionId: dwarf.id,
    ...(dwarf.workplace === undefined
      ? {}
      : {
          workplace: {
            path: dwarf.workplace.path,
            ...(dwarf.workplace.branch === undefined ? {} : { branch: dwarf.workplace.branch })
          }
        }),
    startedAt: dwarf.arrivedAt,
    ...asks
  }
}

export function createBoardFacadeAdapter(deps: BoardFacadeDeps): BoardFacade {
  const defer = deps.defer ?? ((run: () => void) => void setImmediate(run))
  const askFields = deps.askFields ?? (() => ({}))
  let mines = new Map<MineId, MineWire>()
  let dwarfs = new Map<DwarfId, DwarfWire>()
  let pending = false
  let stopped = false

  const board = (): MinesSnapshot => {
    const legacyMines: Mine[] = []
    for (const mine of mines.values()) {
      const materials = materialsOf(mine.totals)
      legacyMines.push({
        id: mine.id,
        path: mine.path,
        name: mine.name,
        tier: mine.tier ?? UNMEASURED_TIER,
        dwarfs: [...dwarfs.values()]
          .filter((d) => d.mineId === mine.id && LEGACY_PROVIDERS.has(d.providerId))
          .map((d) => toLegacyDwarf(d, askFields(d.id))),
        tokensObserved: sumOf(materials),
        materials,
        updatedAt: mine.lastUsedAt
      })
    }
    const vault = {} as MaterialTotals
    for (const material of MATERIALS) {
      vault[material] = legacyMines.reduce(
        (sum, mine) => sum + (mine.materials?.[material] ?? 0),
        0
      )
    }
    return {
      mines: legacyMines,
      tokensObserved: legacyMines.reduce((sum, mine) => sum + mine.tokensObserved, 0),
      materials: vault
    }
  }

  const changed = (): void => {
    if (pending || stopped) return
    pending = true
    defer(() => {
      pending = false
      if (!stopped) deps.push(board())
    })
  }

  const replace = (snapshot: SnapshotPage): void => {
    mines = new Map()
    dwarfs = new Map()
    for (const chunk of snapshot.chunks) {
      if (chunk.section === 'mines') for (const mine of chunk.data) mines.set(mine.id, mine)
      if (chunk.section === 'dwarfs') for (const dwarf of chunk.data) dwarfs.set(dwarf.id, dwarf)
    }
  }

  /** Applies one frame; answers whether the board changed. */
  const apply = (frame: EvtFrame): boolean => {
    switch (frame.name) {
      case 'mine.changed': {
        const { mine } = frame.data as HostFrames['mine.changed']
        mines.set(mine.id, mine)
        return true
      }
      case 'dwarf.arrived':
      case 'dwarf.changed': {
        const { dwarf } = frame.data as HostFrames['dwarf.changed']
        dwarfs.set(dwarf.id, dwarf)
        return true
      }
      case 'dwarf.departed':
        return dwarfs.delete((frame.data as HostFrames['dwarf.departed']).dwarfId)
      default:
        return false
    }
  }

  const unsubscribe = deps.client.subscribe((event) => {
    if (event.kind === 'snapshot') {
      replace(event.snapshot)
      changed()
    } else if (apply(event.frame)) {
      changed()
    }
  })

  return {
    getMines: board,
    refresh: changed,
    dispose() {
      stopped = true
      unsubscribe()
    }
  }
}
