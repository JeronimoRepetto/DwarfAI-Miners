import { reactive } from 'vue'
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
  type SnapshotChunk
} from '@dwarfai/contracts'
import {
  defaultMinesState,
  DWARF_PROVIDERS,
  type Dwarf,
  type DwarfProvider,
  type MaterialTotals,
  type Mine,
  type MinesSnapshot
} from '../types'
import { createReadModel, followHost } from './readModel'
import { useToasts } from './useToasts'

// Singleton store: module-scope state shared by every useMines() caller
// (house style shared with a sibling Vue project).
const state = reactive(defaultMinesState())

/**
 * Every dwarf id the last snapshot carried, or null before the first one.
 *
 * Null and empty are different facts (#156): null is "the panel has not looked
 * yet", so nothing on the next snapshot is an arrival; empty is "the panel
 * looked and the valley was idle", so the next session to start IS one. Kept
 * outside `state` because nothing renders it — it exists only to answer what
 * changed between two snapshots.
 */
let previousDwarfIds: Set<string> | null = null

function dwarfIdsIn(snapshot: MinesSnapshot): Set<string> {
  const ids = new Set<string>()
  for (const mine of snapshot.mines) {
    for (const dwarf of mine.dwarfs) ids.add(dwarf.id)
  }
  return ids
}

/*
 * THE BOARD FROM THE HOST (ISSUE-092; ADR-033 item 3; 14 §4.3, §6.4 row `useMines`).
 *
 * The same singleton becomes a read model of the snapshot's `mines` and `dwarfs` sections and the frames
 * `mine.changed`, `dwarf.arrived`, `dwarf.changed`, `dwarf.departed` (14 §3.5; `mine.removed` and `ledger.changed`
 * join when their catalog entries land). `state` keeps the shape `lib/**` and the components read today, folded the
 * way `BoardFacadeAdapter` (ISSUE-086) folds the same facts for A-12/A-P2, so both sources show one board.
 *
 * - One writer at a time (21 §1 item 4). Until the first Host snapshot is read, `setMines` (today's A-12/A-P2 feed)
 *   writes the board; from then on the Host does, and `setMines` brings only today's open asks onto it (from cut 1
 *   A-P2 is `BoardFacadeAdapter`'s, which folds `LegacyAskRelay`'s asks onto the Host dwarfs until cut 2). The shell
 *   `start`s the Host half at mount from the cut-1 switch (ISSUE-123); a table that refuses A-N01 leaves the board on
 *   today's feed.
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

/** How long a departed dwarf stays on the board while it walks out (NFR-TIM-09: 720 ms, binding until DI-06). */
const WALK_OUT_MS = 720

const MATERIALS: readonly Material[] = ['coal', 'bronze', 'copper', 'silver', 'gold', 'uranium']

/** Today's default tier of a mine not measured yet, as `BoardFacadeAdapter` shows it. */
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
/** Whether the Host feeds the board: set by the first Host snapshot, cleared by `stop`. */
let hostFed = false

/** Today's ask fields of a dwarf, the only part of A-P2 a Host-fed board takes (see `setMines`). */
type LegacyAsks = Partial<Pick<Dwarf, 'pendingQuestion' | 'pendingPermission' | 'waitingReason'>>

/**
 * The open asks today's runtime holds, per Host dwarf id, as A-P2 last carried them (21 §3 `LegacyAskRelay`, cuts 1–4:
 * until cut 2 the ask cards of the rows still `legacy` reach the renderer only through `BoardFacadeAdapter`'s board,
 * which folds them onto the Host dwarf). Cut 2 moves the asks to the Host broker and its `asks` section.
 */
let legacyAsks = new Map<string, LegacyAsks>()

function asksOf(dwarf: Dwarf): LegacyAsks {
  return {
    ...(dwarf.pendingQuestion === undefined ? {} : { pendingQuestion: dwarf.pendingQuestion }),
    ...(dwarf.pendingPermission === undefined
      ? {}
      : { pendingPermission: dwarf.pendingPermission }),
    ...(dwarf.waitingReason === undefined ? {} : { waitingReason: dwarf.waitingReason })
  }
}
const walkers = new Set<(walk: BoardWalk) => void>()

function emit(walk: BoardWalk): void {
  for (const walker of walkers) walker(walk)
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

function toBoardDwarf(dwarf: DwarfWire, status: Dwarf['status']): Dwarf {
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
    startedAt: dwarf.arrivedAt,
    ...legacyAsks.get(dwarf.id)
  }
}

/**
 * Writes the Host board into `state`, in today's shape, with the arrivals of this batch. A republish for new asks only
 * (`asksOnly`) leaves the arrivals alone: they belong to the Host batch that brought them, still to be drawn.
 */
function publish(asksOnly = false): void {
  hostFed = true
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
      updatedAt: mine.lastUsedAt
    }
  })
  const vault = {} as MaterialTotals
  for (const material of MATERIALS) {
    vault[material] = mines.reduce((sum, mine) => sum + (mine.materials?.[material] ?? 0), 0)
  }
  state.mines = mines
  state.tokensObserved = mines.reduce((sum, mine) => sum + mine.tokensObserved, 0)
  state.materials = vault
  if (asksOnly) return
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
  if (announce && mine !== undefined) useToasts().showToast(startedIn(dwarf, mine))
}

function depart(dwarfId: DwarfId, mineId: MineId, cause: DepartureCause): void {
  const dwarf = board.dwarfs.get(dwarfId)
  if (dwarf === undefined) return
  board.dwarfs.delete(dwarfId)
  const timer = setTimeout(() => {
    leaving.delete(dwarfId)
    publish()
  }, WALK_OUT_MS)
  leaving.set(dwarfId, { dwarf, timer })
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
 * Follows the Host read path (A-N02 first, then A-N01). Answers whether the Host now feeds the board; when it
 * does not (the rows are unrouted, or the Host did not answer a snapshot), today's feed keeps writing it.
 */
async function start(): Promise<boolean> {
  follower ??= followHost(
    {
      subscribe: (listener) => window.api.onHostEvent((frames) => listener(frames as HostFrame[])),
      snapshot: (params) => window.api.getHostSnapshot(params)
    },
    { model, sections: ['mines', 'dwarfs'], dataOf: boardOf, settled: publish }
  )
  return follower.start()
}

/** Stops following the Host; the board keeps its last state and today's feed may write it again. */
function stop(): void {
  follower?.stop()
  follower = null
  forgetLeaving()
  board.mines = new Map()
  board.dwarfs = new Map()
  arrivals = new Set()
  hostFed = false
  legacyAsks = new Map()
}

export function useMines() {
  function setMines(snapshot: MinesSnapshot): void {
    // One writer at a time (21 §1 item 4): once the Host feeds the board, today's feed no longer writes it. From the
    // cut-1 switch that feed is `BoardFacadeAdapter`'s, and the one thing it still brings is today's open asks
    // (`legacyAsks`), which only it carries until cut 2.
    if (hostFed) {
      legacyAsks = new Map(
        snapshot.mines.flatMap((mine) => mine.dwarfs).map((dwarf) => [dwarf.id, asksOf(dwarf)])
      )
      publish(true)
      return
    }
    const ids = dwarfIdsIn(snapshot)
    state.arrived =
      previousDwarfIds === null
        ? new Set()
        : new Set([...ids].filter((id) => !previousDwarfIds!.has(id)))
    previousDwarfIds = ids
    state.mines = snapshot.mines
    state.tokensObserved = snapshot.tokensObserved
    // Carried through as published, undefined included: an older snapshot with
    // no breakdown is an empty vault the panel can render, not a fault.
    state.materials = snapshot.materials
  }

  function clear(): void {
    state.mines = []
    state.tokensObserved = 0
    state.materials = undefined
    // Back to "has not looked": what the panel sees next is a first snapshot
    // again, not a valley of arrivals.
    state.arrived = new Set()
    previousDwarfIds = null
  }

  return {
    state,
    setMines,
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
    /** The Host read model's dwarfs (snapshot `dwarfs` with live frames), e.g. for Stop everything's count. */
    hostDwarfs: (): readonly DwarfWire[] => [...board.dwarfs.values()]
  }
}
