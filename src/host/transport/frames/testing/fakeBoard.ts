// The board's read side faked for the transport's board tests (17 §1.6 "faked modules"): the
// mines and crew queries the snapshot sections and the board frames read, over plain maps a test
// fills, and one view of a mine and of a dwarf with every field set. Test-only (R14): never
// imported by production code.
import type { DwarfId, MineId } from '../../../kernel/domain/values'
import type { CrewQueries, DwarfView, StatusFacts } from '../../../modules/crew'
import type {
  MineName,
  MinePath,
  MineSummary,
  MinesQueries,
  MineView
} from '../../../modules/mines'

export const BOARD_T0 = 1_790_000_000_000

/** A mine on the board, `unrecorded` and never measured unless `over` says otherwise. */
export function mineView(id: string, name: string, over: Partial<MineView> = {}): MineView {
  return {
    id: id as MineId,
    path: `/work/${name}` as MinePath,
    name: name as MineName,
    state: 'unrecorded',
    tier: null,
    sourceWeight: null,
    hasBeenMeasured: false,
    createdAt: BOARD_T0,
    lastUsedAt: BOARD_T0,
    mapSite: { xPct: 10, yPct: 20 },
    presentDwarfs: 0,
    ...over
  }
}

/** A present, running, idle dwarf the app only observes, unless `over` says otherwise. */
export function dwarfView(id: string, mineId: string, over: Partial<DwarfView> = {}): DwarfView {
  const facts: StatusFacts = {
    processState: 'running',
    turn: { state: 'none-yet', arrivedAt: BOARD_T0 },
    lastActivityAt: BOARD_T0
  }
  return {
    id: id as DwarfId,
    mineId: mineId as MineId,
    identity: { providerId: 'claude', providerSessionId: `session-${id}` },
    previousProviderSessionId: null,
    baseName: 'Borin',
    customName: null,
    delegated: false,
    sessionProfile: { providerId: 'claude' },
    stopInFlight: false,
    usagePath: 'transcript',
    parentDwarfId: null,
    rank: 'foreman',
    facts,
    arrivedAt: BOARD_T0,
    pendingEnd: null,
    presence: 'present',
    processState: 'running',
    departedAt: null,
    departureCause: null,
    providerId: 'claude',
    displayName: 'Borin',
    status: 'idle',
    needsYou: false,
    canReceiveMessages: false,
    stopUnavailableReason: null,
    owned: false,
    departed: false,
    ...over
  }
}

/** `MinesQueries.list` and `get` over a map: removed mines are never listed nor got (09 §4.11). */
export class FakeMinesQueries implements Pick<MinesQueries, 'list' | 'get'> {
  readonly mines = new Map<string, MineView>()

  put(view: MineView): void {
    this.mines.set(view.id, view)
  }

  list(): MineSummary[] {
    return [...this.mines.values()]
      .filter((mine) => mine.state !== 'removed')
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
      .map((mine) => ({
        mineId: mine.id,
        name: mine.name,
        path: mine.path,
        tier: mine.tier,
        lastUsedAt: mine.lastUsedAt,
        presentDwarfs: mine.presentDwarfs,
        removed: false
      }))
  }

  get(mineId: MineId): MineView | null {
    const mine = this.mines.get(mineId)
    return mine === undefined || mine.state === 'removed' ? null : mine
  }
}

/** `CrewQueries.crewOf` (the present crew by default) and `get` over a map. */
export class FakeCrewQueries implements Pick<CrewQueries, 'crewOf' | 'get'> {
  readonly dwarfs = new Map<string, DwarfView>()

  put(view: DwarfView): void {
    this.dwarfs.set(view.id, view)
  }

  crewOf(mineId: MineId, opts?: { includeDeparted?: boolean }): DwarfView[] {
    return [...this.dwarfs.values()].filter(
      (dwarf) => dwarf.mineId === mineId && (opts?.includeDeparted === true || !dwarf.departed)
    )
  }

  get(dwarfId: DwarfId): DwarfView | null {
    return this.dwarfs.get(dwarfId) ?? null
  }
}
