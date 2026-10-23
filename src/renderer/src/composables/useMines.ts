import { reactive, shallowRef, type InjectionKey } from 'vue'
import {
  HOST_FRAME_SCHEMAS,
  type DepartureCause,
  type DwarfId,
  type DwarfWire,
  type HostFrame,
  type Material,
  type MaterialAmount,
  type MineId,
  type MineWire,
  type SnapshotChunk,
  type StopUnavailableReason
} from '@dwarfai/contracts'
import {
  defaultMinesState,
  DWARF_PROVIDERS,
  type Dwarf,
  type DwarfProvider,
  type MaterialTotals,
  type Mine
} from '../types'
import { LEAVING_EXIT_MS } from '../lib/presentation'
import type { HostDeliveryFacts } from '../lib/delivery/deliveryRoute'
import type { BoardDwarf } from '../lib/scene/boardDwarf'
import { MAX_WALK_MS, prefersReducedMotion } from '../lib/scene/sceneMotion'
import { createReadModel, followHost } from './readModel'
import { useToasts } from './useToasts'

// Singleton store: module-scope state shared by every useMines() caller
// (house style shared with a sibling Vue project).
const state = reactive(defaultMinesState())

/*
 * THE BOARD FROM THE HOST (ISSUE-092; ADR-033 item 3; 14 §4.3, §6.4 row `useMines`).
 *
 * The same singleton becomes a read model of the snapshot's `mines` and `dwarfs` sections and the frames
 * `mine.changed`, `mine.removed`, `ledger.changed`, `dwarf.arrived`, `dwarf.changed`, `dwarf.departed` (14 §3.5). `state` keeps the shape `lib/**` and the components read today.
 *
 * - The Host is the board's one writer (21 §1 item 4). AMENDED for ISSUE-242, cut 5 (was: until the first Host snapshot
 *   was read, today's A-12/A-P2 feed, from cut 1 `BoardFacadeAdapter`'s, wrote the board through `setMines`, and after it
 *   brought today's board fields onto the Host dwarfs): A-12 and A-P2 are deleted with the facade, so the shell `start`s
 *   this read model at mount and a Host that has not answered yet shows an empty board.
 * - Arrivals: a snapshot is never an arrival (S2.03); a `dwarf.arrived` frame emits one walk-in and puts the dwarf in
 *   `state.arrived` for the batch it came in (S2.02), and with `announce` raises the toast "<d> started in <name>"
 *   (US-OBS-002.AC07; 08 §2.2).
 * - Departures are events, never differences (14 §4.3 rule 6): only `dwarf.departed` emits a walk-out. The dwarf
 *   stays on the board as today's 'leaving' while it walks out, so an open MessagePanel keeps showing it with the
 *   composer disabled (S2.04, S2.06), then its sprite is dropped (S2.17). The walk-out says whether its panel stays
 *   open read-only or closes with its mine (S2.05). A dwarf missing from a re-snapshot simply disappears; silence
 *   never removes one (S2.16).
 * - The renderer never derives a status (ADR-032 item 1): today's three board states are read off the Host's
 *   `status` and `presence`, as the facade reads them.
 */

/** One walk the board's interiors play (S2.02, S2.04…S2.07). */
export type BoardWalk =
  | { kind: 'walk-in'; dwarfId: DwarfId; mineId: MineId }
  | {
      kind: 'walk-out'
      dwarfId: DwarfId
      mineId: MineId
      cause: DepartureCause
      /** What an open MessagePanel on this dwarf does: stays open read-only, or closes with its mine (S2.05). */
      panel: 'read-only' | 'closed'
    }

/**
 * How long a departed dwarf stays on the board when no sprite says it is walking out (its mine is not open, or the
 * column never walked it): the 720 ms of US-MINE-009 (NFR-TIM-09).
 *
 * A sprite that IS walking out holds it instead (ISSUE-255): the walk keeps today's corridor route and speed, the
 * pinned design's ruling over the 720 ms, so it lasts as long as that route and its fade, from a fraction of a second
 * to a long climb. The sprite says when it has gone (`walkedOut`); a flat 720 ms would cut a long walk-out short and
 * hold a short one.
 */
const WALK_OUT_MS = 720
/** The longest a walking-out sprite may hold its dwarf on the board: the longest walk and its fade. */
const WALK_OUT_HOLD_MS = MAX_WALK_MS + LEAVING_EXIT_MS

const MATERIALS: readonly Material[] = ['coal', 'bronze', 'copper', 'silver', 'gold', 'uranium']

/** Today's default tier of a mine not measured yet (`defaultMine()` of today's board). */
const UNMEASURED_TIER: Mine['tier'] = 'bronze'

const LEGACY_PROVIDERS: ReadonlySet<string> = new Set(DWARF_PROVIDERS)

/** The toast of an announced arrival (copy template `{d} started in {name}`; PO decision 2026-09-28 #48). */
function startedIn(dwarf: DwarfWire, mine: MineWire): string {
  return `${dwarf.customName ?? dwarf.baseName} started in ${mine.name}`
}

interface HostBoard {
  mines: Map<MineId, MineWire>
  dwarfs: Map<DwarfId, DwarfWire>
}

const board: HostBoard = { mines: new Map(), dwarfs: new Map() }
/** Dwarfs that departed and are still walking out, with the timer that drops them. */
const leaving = new Map<DwarfId, { dwarf: DwarfWire; timer: ReturnType<typeof setTimeout> }>()
/** The dwarfs that arrived by frame since the board was last published. */
let arrivals = new Set<string>()
/**
 * Each Host dwarf's `stopUnavailableReason` (14 §3.6 `DwarfWire`) as the board last published it: the one fact
 * "Stop dwarf…" reads its availability from (INV-31; 14 §4.1 `dwarfs` consumer `useDwarfStopping`). Reactive, so a
 * control reading it follows every snapshot and `dwarf.changed`; never derived in the renderer.
 */
const stopReasons = shallowRef<ReadonlyMap<string, StopUnavailableReason | null>>(new Map())

const walkers = new Set<(walk: BoardWalk) => void>()

function emit(walk: BoardWalk): void {
  for (const walker of walkers) walker(walk)
}

/** Drops a departed dwarf from the board, once its walk-out is over. */
function dropLeaver(dwarfId: string): void {
  const entry = leaving.get(dwarfId as DwarfId)
  if (entry === undefined) return
  clearTimeout(entry.timer)
  leaving.delete(dwarfId as DwarfId)
  publish()
}

function forgetLeaving(): void {
  for (const { timer } of leaving.values()) clearTimeout(timer)
  leaving.clear()
}

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

/*
 * AMENDED for ISSUE-254 (ADR-032 D2; ADR-033 item 3): the Host's own status rides on the board dwarf
 * (`hostStatus`, lib/scene/boardDwarf), since today's `status` folds asking, idle and asleep into one
 * `waiting`; the scene reads it first, so a Host-idle dwarf reads "Waiting", never asleep.
 */
/*
 * The Host's `canReceiveMessages` ("composer enabled", INV-33) and `owned` ride on the board dwarf too
 * (lib/delivery/deliveryRoute `HostDeliveryFacts`): the composer is enabled from the Host's flag, never
 * from a `textDelivery` only today's overlay carries.
 */
function toBoardDwarf(dwarf: DwarfWire, status: Dwarf['status']): BoardDwarf & HostDeliveryFacts {
  const { model, effort } = dwarf.sessionProfile
  return {
    id: dwarf.id,
    provider: dwarf.providerId as DwarfProvider,
    role: dwarf.rank,
    name: dwarf.baseName,
    ...(dwarf.customName === null ? {} : { customName: dwarf.customName }),
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    status,
    hostStatus: dwarf.status,
    canReceiveMessages: dwarf.canReceiveMessages,
    owned: dwarf.owned,
    ...(dwarf.parentDwarfId === null ? {} : { parentId: dwarf.parentDwarfId }),
    // Today's board names a dwarf's session; the Host's id stands in for it (ADR-015: provider ids stay apart).
    sessionId: dwarf.id,
    ...(dwarf.workplace === undefined
      ? {}
      : {
          workplace: {
            path: dwarf.workplace.path,
            ...(dwarf.workplace.branch === undefined ? {} : { branch: dwarf.workplace.branch })
          }
        }),
    startedAt: dwarf.arrivedAt
  }
}

/** Writes the Host board into `state`, in today's shape, with the arrivals of this batch. */
function publish(): void {
  const shown: Array<{ dwarf: DwarfWire; status: Dwarf['status'] }> = [
    ...[...board.dwarfs.values()].map((dwarf) => ({ dwarf, status: statusOf(dwarf) })),
    ...[...leaving.values()].map(({ dwarf }) => ({ dwarf, status: 'leaving' as const }))
  ]
  const mines: Mine[] = [...board.mines.values()].map((mine) => {
    const materials = materialsOf(mine.totals)
    return {
      id: mine.id,
      path: mine.path,
      name: mine.name,
      tier: mine.tier ?? UNMEASURED_TIER,
      dwarfs: shown
        .filter(({ dwarf }) => dwarf.mineId === mine.id && LEGACY_PROVIDERS.has(dwarf.providerId))
        .map(({ dwarf, status }) => toBoardDwarf(dwarf, status)),
      tokensObserved: sumOf(materials),
      materials,
      updatedAt: mine.lastUsedAt,
      // The card's tier progress and measuring state (AMENDMENT-26; US-MINES-008), as the Host said them.
      ...(mine.score === undefined
        ? {}
        : { score: { kb: mine.score.kb, nextTierKb: mine.score.nextTierKb } }),
      ...(mine.state === 'measuring' ? { measuring: true } : {})
    }
  })
  const vault = {} as MaterialTotals
  for (const material of MATERIALS) {
    vault[material] = mines.reduce((sum, mine) => sum + (mine.materials?.[material] ?? 0), 0)
  }
  state.mines = mines
  state.tokensObserved = mines.reduce((sum, mine) => sum + mine.tokensObserved, 0)
  state.materials = vault
  stopReasons.value = new Map(
    [...board.dwarfs.values()].map((dwarf) => [dwarf.id, dwarf.stopUnavailableReason])
  )
  state.arrived = arrivals
  arrivals = new Set()
}

function arrive(dwarf: DwarfWire, announce: boolean): void {
  const known = board.dwarfs.has(dwarf.id)
  board.dwarfs.set(dwarf.id, dwarf)
  if (known) return
  arrivals.add(dwarf.id)
  emit({ kind: 'walk-in', dwarfId: dwarf.id, mineId: dwarf.mineId })
  const mine = board.mines.get(dwarf.mineId)
  if (announce && announcing && mine !== undefined) useToasts().showToast(startedIn(dwarf, mine))
}

function depart(dwarfId: DwarfId, mineId: MineId, cause: DepartureCause): void {
  const dwarf = board.dwarfs.get(dwarfId)
  if (dwarf === undefined) return
  board.dwarfs.delete(dwarfId)
  // Under reduced motion there is no walk-out to wait for: the dwarf is gone at once (US-MINE-009.AC05).
  if (!prefersReducedMotion()) {
    leaving.set(dwarfId, { dwarf, timer: setTimeout(() => dropLeaver(dwarfId), WALK_OUT_MS) })
  }
  emit({
    kind: 'walk-out',
    dwarfId,
    mineId,
    cause,
    panel: cause === 'mine-removed' ? 'closed' : 'read-only'
  })
}

/** Applies one frame newer than the snapshot; a frame whose data is not its 14 §3.5 payload is ignored. */
function applyFrame(frame: HostFrame): void {
  switch (frame.name) {
    case 'mine.changed': {
      const parsed = HOST_FRAME_SCHEMAS['mine.changed'].safeParse(frame.data)
      if (parsed.success) board.mines.set(parsed.data.mine.id, parsed.data.mine)
      return
    }
    case 'mine.removed': {
      // B-F07: the mine and its ore leave the board at once (US-MINES-006.AC03); its dwarfs departed first.
      const parsed = HOST_FRAME_SCHEMAS['mine.removed'].safeParse(frame.data)
      if (parsed.success) board.mines.delete(parsed.data.mineId)
      return
    }
    case 'ledger.changed': {
      // The ore a turn earned (14 §2.4 B-F20): the mine's six totals, each on its own (INV-93).
      const parsed = HOST_FRAME_SCHEMAS['ledger.changed'].safeParse(frame.data)
      const mine = parsed.success ? board.mines.get(parsed.data.mineId) : undefined
      if (parsed.success && mine !== undefined)
        board.mines.set(mine.id, { ...mine, totals: parsed.data.totals })
      return
    }
    case 'dwarf.arrived': {
      const parsed = HOST_FRAME_SCHEMAS['dwarf.arrived'].safeParse(frame.data)
      if (parsed.success) arrive(parsed.data.dwarf, parsed.data.announce)
      return
    }
    case 'dwarf.changed': {
      const parsed = HOST_FRAME_SCHEMAS['dwarf.changed'].safeParse(frame.data)
      if (parsed.success && board.dwarfs.has(parsed.data.dwarf.id))
        board.dwarfs.set(parsed.data.dwarf.id, parsed.data.dwarf)
      return
    }
    case 'dwarf.departed': {
      const parsed = HOST_FRAME_SCHEMAS['dwarf.departed'].safeParse(frame.data)
      if (parsed.success) depart(parsed.data.dwarfId, parsed.data.mineId, parsed.data.cause)
      return
    }
    default:
      return
  }
}

const model = createReadModel<HostBoard, HostFrame>({
  state: board,
  replace(data) {
    // A snapshot replaces the board whole: nobody in it walks in, nobody missing from it walks out.
    forgetLeaving()
    arrivals = new Set()
    board.mines = data.mines
    board.dwarfs = data.dwarfs
  },
  apply: applyFrame
})

function boardOf(chunks: readonly SnapshotChunk[]): HostBoard {
  const next: HostBoard = { mines: new Map(), dwarfs: new Map() }
  for (const chunk of chunks) {
    if (chunk.section === 'mines') for (const mine of chunk.data) next.mines.set(mine.id, mine)
    if (chunk.section === 'dwarfs') for (const dwarf of chunk.data) next.dwarfs.set(dwarf.id, dwarf)
  }
  return next
}

let follower: ReturnType<typeof followHost<HostBoard>> | null = null
/**
 * Whether this window's board says an announced arrival itself (US-OBS-002.AC07): the Panel's does; Valle's does not,
 * since Valle says it once through its own arrival toast (ISSUE-304).
 */
let announcing = true

/**
 * Follows the Host read path (A-N02 first, then A-N01). Answers whether the Host now feeds the board; when it does
 * not (the Host did not answer a snapshot), the board stays as it is until a later read succeeds.
 */
async function start(options: { announce?: boolean } = {}): Promise<boolean> {
  announcing = options.announce ?? true
  follower ??= followHost(
    {
      subscribe: (listener) => window.api.onHostEvent((frames) => listener(frames as HostFrame[])),
      snapshot: (params) => window.api.getHostSnapshot(params)
    },
    { model, sections: ['mines', 'dwarfs'], dataOf: boardOf, settled: publish }
  )
  return follower.start()
}

/** Stops following the Host; the board keeps its last state. */
function stop(): void {
  follower?.stop()
  follower = null
  forgetLeaving()
  board.mines = new Map()
  board.dwarfs = new Map()
  arrivals = new Set()
  stopReasons.value = new Map()
}

/**
 * What a sprite tells the board about a departed dwarf's walk-out (ISSUE-255): `useMines`'s own `walkingOut` and
 * `walkedOut` by default; a test, or a page with no board, provides its own under this key.
 */
export interface WalkOutReporter {
  walkingOut: (dwarfId: string) => void
  walkedOut: (dwarfId: string) => void
}
export const WALK_OUT_KEY: InjectionKey<WalkOutReporter> = Symbol('walk-out')

export function useMines() {
  function clear(): void {
    state.mines = []
    state.tokensObserved = 0
    state.materials = undefined
    state.arrived = new Set()
  }

  return {
    state,
    clear,
    start,
    stop,
    /** Every walk-in and walk-out from now on (S2.02, S2.04…S2.07); answers the unsubscribe. */
    onWalk(listener: (walk: BoardWalk) => void): () => void {
      walkers.add(listener)
      return () => {
        walkers.delete(listener)
      }
    },
    /**
     * A sprite has set off on this departed dwarf's walk-out (SceneDwarf): the board keeps the dwarf until that sprite
     * says it has gone, for at most the longest walk and its fade. A dwarf that is not departing is left alone.
     */
    walkingOut(dwarfId: string): void {
      const entry = leaving.get(dwarfId as DwarfId)
      if (entry === undefined) return
      clearTimeout(entry.timer)
      entry.timer = setTimeout(() => dropLeaver(dwarfId), WALK_OUT_HOLD_MS)
    },
    /** The sprite walking this departed dwarf out has gone: the board drops it now. */
    walkedOut(dwarfId: string): void {
      dropLeaver(dwarfId)
    },
    /** The Host read model's dwarfs (snapshot `dwarfs` with live frames), e.g. for Stop everything's count. */
    hostDwarfs: (): readonly DwarfWire[] => [...board.dwarfs.values()],
    /**
     * Why "Stop dwarf…" is unavailable for this dwarf as the Host said it (INV-31: only `already-stopping`), or null
     * when it is available or the Host holds no such dwarf. Reactive.
     */
    stopUnavailableReason: (dwarfId: string): StopUnavailableReason | null =>
      stopReasons.value.get(dwarfId) ?? null
  }
}
