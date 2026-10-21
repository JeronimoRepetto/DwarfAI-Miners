/*
 * Veta's life state, 07 machine 20 (US-VETA-001, US-VETA-010; UC-044; ISSUE-287): which of the strip's three states
 * of life shows, plus the first-run variant of the closed entrance. The person never picks it: it is derived from the
 * Host facts alone, the `mines` and `dwarfs` read models with their frames and `meta.minesEverKnown` (`06` D-30: a
 * renderer presentation state, never persisted).
 *
 * - `first-run`: no mine was ever declared or observed; the closed entrance carries "+" and asks for the empty mine
 *   picker (S20.13).
 * - `no-sessions`: a mine is known and no dwarf is present; the closed entrance moves to the Panel (S20.12). A dwarf
 *   `resuming` after a Host restart, and one listed unrecovered, count as present (ADR-032 D7, S2.10).
 * - `all-idle`: dwarfs are present and none works or asks; every chamber stays.
 * - `sessions-working`: a present dwarf works or asks; a chamber holding an asking dwarf is lit and that dwarf shows
 *   "?" (attention level 1). Chambers keep the order they opened in, a new one last (S26.05): a needing mine never
 *   jumps to the front.
 *
 * `createVetaLife` tracks the facts the way the read model hands them over (a snapshot replaces them whole; a frame
 * changes one record) and names every step by its 07 id. Facts that arrive while the window is not shown are tracked
 * with no choreography, and the next show renders the settled state (S20.17). A step 07 does not list is rejected and
 * the state is held. Removing the last mine keeps `minesEverKnown` (a removed mine stays a Host record), so it leads to
 * `no-sessions`, never back to `first-run`; only the re-snapshot after Reset metrics does that (S20.11).
 *
 * It also reads out every live mine with its present crew, chamber or not (`mines`): the mine picker's list
 * (07 S22.07; ISSUE-288).
 *
 * Pure: no DOM, no clock, no `window.api`.
 */
import {
  HOST_FRAME_SCHEMAS,
  type DwarfId,
  type DwarfWire,
  type HostFrame,
  type HostFrames,
  type MineId,
  type MineWire
} from '@dwarfai/contracts'

export type VetaLifeState = 'first-run' | 'no-sessions' | 'all-idle' | 'sessions-working'

/** What activating the closed entrance asks for: the empty mine picker on first run, the Panel otherwise. */
export type EntranceIntent = 'open-picker' | 'open-panel'

/** What moved the facts: the window shown, a Host frame, or a (re-)snapshot. */
export type LifeCause = 'show' | 'frame' | 'snapshot'

export interface VetaFacts {
  /** `SnapshotMeta.minesEverKnown` (14 §3.7; 07 N-11). */
  readonly minesEverKnown: boolean
  readonly mines: readonly MineWire[]
  readonly dwarfs: readonly DwarfWire[]
}

export type LifeStep =
  | {
      readonly ok: true
      /** The 07 transition id. */
      readonly id: string
      /** `null` for `[*]`: the window shown, or the first snapshot. */
      readonly from: VetaLifeState | null
      readonly to: VetaLifeState
      /** Whether a choreography may run: a frame that crosses a state while the window is shown. */
      readonly animate: boolean
    }
  | {
      readonly ok: false
      readonly from: VetaLifeState | null
      readonly to: VetaLifeState
      readonly cause: LifeCause
    }

/** One drawn chamber: a mine at work, its present dwarfs in first-seen order, lit when one of them asks. */
export interface VetaChamberView {
  readonly mine: MineWire
  readonly dwarfs: readonly DwarfWire[]
  readonly attention: boolean
}

/** A live mine and how many of its dwarfs are present (the mine picker's rows, 07 S22.07). */
export interface VetaMineView {
  readonly mine: MineWire
  readonly crew: number
}

export interface VetaLife {
  /** `null` until the first snapshot: nothing is known yet. */
  readonly state: VetaLifeState | null
  readonly shown: boolean
  /** The chambers to draw, in mine order; none in `first-run` and `no-sessions`. */
  readonly chambers: readonly VetaChamberView[]
  /** Every live mine in mine order with its present crew, those with no chamber included (US-VETA-003.AC05). */
  readonly mines: readonly VetaMineView[]
  /** The last step taken or refused. */
  readonly last: LifeStep | null
  applySnapshot(data: VetaFacts): void
  applyFrame(frame: HostFrame): void
  show(): void
  hide(): void
}

/** Present in its mine: `resuming` and a dwarf listed unrecovered count (ADR-032 D7, S2.10); `walking-out` does not. */
export function isPresent(dwarf: Pick<DwarfWire, 'presence'>): boolean {
  return dwarf.presence === 'present' || dwarf.presence === 'resuming'
}

const isActive = (dwarf: Pick<DwarfWire, 'status'>): boolean =>
  dwarf.status === 'working' || dwarf.status === 'asking'

/** The life state the facts give (07 machine 20 invariants). */
export function deriveLifeState(facts: VetaFacts): VetaLifeState {
  const present = facts.dwarfs.filter(isPresent)
  if (present.length > 0) return present.some(isActive) ? 'sessions-working' : 'all-idle'
  // A mine the Host holds was declared or observed, so it is known whatever the meta says. Load-bearing until
  // ISSUE-082: the Host's `SnapshotMeta.minesEverKnown` is always false before then (host/main.ts), so with every mine
  // removed and no dwarf this shows `first-run` where 07 asks for `no-sessions` (a known risk, closed by ISSUE-082).
  const known = facts.minesEverKnown || facts.mines.length > 0
  return known ? 'no-sessions' : 'first-run'
}

/** S20.12, S20.13: the closed entrance's one action; the chambers' states have no entrance. */
export function entranceIntent(state: VetaLifeState): EntranceIntent | null {
  if (state === 'first-run') return 'open-picker'
  if (state === 'no-sessions') return 'open-panel'
  return null
}

/** S20.01–S20.04: `[*]` → the state, when Veta is shown or first learns its facts. */
const INITIAL: Readonly<Record<VetaLifeState, string>> = {
  'first-run': 'S20.01',
  'no-sessions': 'S20.02',
  'all-idle': 'S20.03',
  'sessions-working': 'S20.04'
}

/** The frame-driven transitions 07 lists, `from>to` → id. */
const BY_FRAME: Readonly<Record<string, string>> = {
  'first-run>no-sessions': 'S20.05',
  'first-run>sessions-working': 'S20.06',
  'no-sessions>sessions-working': 'S20.06',
  'first-run>all-idle': 'S20.07',
  'no-sessions>all-idle': 'S20.07',
  'all-idle>sessions-working': 'S20.08',
  'sessions-working>all-idle': 'S20.09',
  'all-idle>no-sessions': 'S20.10',
  'sessions-working>no-sessions': 'S20.10'
}

/** The 07 transition from `from` to `to` for `cause`, or its refusal. */
export function stepLifeState(
  from: VetaLifeState | null,
  to: VetaLifeState,
  cause: LifeCause
): LifeStep {
  const taken = (id: string, animate = false): LifeStep => ({ ok: true, id, from, to, animate })
  if (from === null || cause === 'show') return taken(INITIAL[to])
  if (cause === 'snapshot') {
    // S20.11 after Reset metrics; any other re-snapshot is recomputed without choreography (S20.16).
    return taken(to === 'first-run' ? 'S20.11' : 'S20.16')
  }
  if (from === to) return taken('S20.14')
  const id = BY_FRAME[`${from}>${to}`]
  return id === undefined ? { ok: false, from, to, cause } : taken(id, true)
}

/** The frames that change Veta's facts (B-F06…B-F10). */
type FactFrame =
  'mine.changed' | 'mine.removed' | 'dwarf.arrived' | 'dwarf.changed' | 'dwarf.departed'

/** A frame's data, checked against its 14 §3.5 shape; `null` for another frame or a malformed one. */
function factOf<F extends FactFrame>(frame: HostFrame, name: F): HostFrames[F] | null {
  if (frame.name !== name) return null
  const parsed = HOST_FRAME_SCHEMAS[name].safeParse(frame.data)
  return parsed.success ? (parsed.data as HostFrames[F]) : null
}

export function createVetaLife(): VetaLife {
  const mines = new Map<MineId, MineWire>()
  const dwarfs = new Map<DwarfId, DwarfWire>()
  // First-seen and stable: a mine or a dwarf keeps its place for as long as the window lives.
  const mineOrder: MineId[] = []
  const dwarfOrder: DwarfId[] = []
  let everKnown = false
  let state: VetaLifeState | null = null
  let shown = false
  let last: LifeStep | null = null
  let chambers: readonly VetaChamberView[] = []

  const seeMine = (id: MineId): void => {
    if (!mineOrder.includes(id)) mineOrder.push(id)
  }
  const seeDwarf = (id: DwarfId): void => {
    if (!dwarfOrder.includes(id)) dwarfOrder.push(id)
  }

  /*
   * The chambers in the order they opened (07 S26.05; ISSUE-292): a mine's chamber opens last, at the far end, whatever
   * its place in the Host's list, and keeps its place while it stays open. A chamber that closes leaves the order; one
   * that opens again opens last. The first chambers known open in mine order.
   */
  const chamberOrder: MineId[] = []

  function drawChambers(): readonly VetaChamberView[] {
    const present = dwarfOrder
      .map((id) => dwarfs.get(id))
      .filter((d): d is DwarfWire => d !== undefined && isPresent(d))
    const views = new Map<MineId, VetaChamberView>()
    for (const mineId of mineOrder) {
      const mine = mines.get(mineId)
      const crew = present.filter((d) => d.mineId === mineId)
      if (mine === undefined || crew.length === 0) continue
      views.set(mineId, { mine, dwarfs: crew, attention: crew.some((d) => d.status === 'asking') })
    }
    const kept = chamberOrder.filter((mineId) => views.has(mineId))
    const opened = mineOrder.filter((mineId) => views.has(mineId) && !kept.includes(mineId))
    chamberOrder.splice(0, chamberOrder.length, ...kept, ...opened)
    return chamberOrder.map((mineId) => views.get(mineId)!)
  }

  function settle(cause: LifeCause): void {
    const next = deriveLifeState({
      minesEverKnown: everKnown,
      mines: [...mines.values()],
      dwarfs: [...dwarfs.values()]
    })
    const step = stepLifeState(state, next, cause)
    if (!step.ok) {
      last = step
      return
    }
    last = { ...step, animate: step.animate && shown }
    state = next
    chambers = drawChambers()
  }

  return {
    get state() {
      return state
    },
    get shown() {
      return shown
    },
    get chambers() {
      return chambers
    },
    get mines() {
      const present = [...dwarfs.values()].filter(isPresent)
      return mineOrder.flatMap((mineId): VetaMineView[] => {
        const mine = mines.get(mineId)
        if (mine === undefined) return []
        return [{ mine, crew: present.filter((d) => d.mineId === mineId).length }]
      })
    },
    get last() {
      return last
    },
    applySnapshot(data) {
      mines.clear()
      dwarfs.clear()
      for (const mine of data.mines) {
        mines.set(mine.id, mine)
        seeMine(mine.id)
      }
      for (const dwarf of data.dwarfs) {
        dwarfs.set(dwarf.id, dwarf)
        seeDwarf(dwarf.id)
      }
      everKnown = data.minesEverKnown || data.mines.length > 0
      settle('snapshot')
    },
    applyFrame(frame) {
      const changed = factOf(frame, 'mine.changed')
      const removed = factOf(frame, 'mine.removed')
      const dwarf = factOf(frame, 'dwarf.arrived') ?? factOf(frame, 'dwarf.changed')
      const departed = factOf(frame, 'dwarf.departed')
      if (changed !== null) {
        mines.set(changed.mine.id, changed.mine)
        seeMine(changed.mine.id)
        everKnown = true
      } else if (removed !== null) {
        // The record stays the Host's: `minesEverKnown` holds (07 machine 20 coverage).
        mines.delete(removed.mineId)
      } else if (dwarf !== null) {
        dwarfs.set(dwarf.dwarf.id, dwarf.dwarf)
        seeDwarf(dwarf.dwarf.id)
      } else if (departed !== null) {
        dwarfs.delete(departed.dwarfId)
      } else {
        return
      }
      settle('frame')
    },
    show() {
      shown = true
      if (state !== null)
        last = { ok: true, id: INITIAL[state], from: null, to: state, animate: false }
    },
    hide() {
      shown = false
    }
  }
}
