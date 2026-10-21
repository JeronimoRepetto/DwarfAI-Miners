/*
 * Veta's arrival and departure choreography carried out (07 machine 26; UC-050; US-VETA-007, US-VETA-008; ISSUE-292),
 * over the pure machine of `lib/veta/choreography.ts`.
 *
 * - Its inputs are the `dwarf.arrived` and `dwarf.departed` frames alone (`useVetaLife.onFacts`; ADR-033 item 3): a
 *   status change, silence (S26.17) or a snapshot (S26.15) never walks anyone, and nothing walks while Veta is not the
 *   shown mode (S26.16): the settled layout shows on the next show.
 * - It draws the staged strip (`chambers`): the facts, less the arrivals not placed yet, with each departed dwarf still
 *   standing where it stood until it has walked out (and its emptied chamber until it has closed).
 * - The window grows before a growth (`grow`, sent as `layoutVeta {island-resize}` for the final island, anchor fixed;
 *   ADR-025 item 2) and shrinks after the motion (`shrink`), never during it.
 * - Each state's motion is played by the window (`play`), which owns the elements; each resolves on its finishing, or
 *   on the watchdog at its duration + 40 ms (S26.13), whichever comes first; the window going hidden, or reduced motion,
 *   applies the end state at once (S26.12, S26.13).
 * - One choreography runs at a time; the frames that arrive meanwhile wait in order, held out of (or kept in) the strip
 *   until their turn. A departure of a dwarf still walking in does not wait: its walk resolves at once and it walks out
 *   (S26.14).
 * - A departing dwarf's risen chat follows S24.10 / S24.11 for its cause (`chat`, ISSUE-290's rules) as it walks out.
 * - Veta plays no footsteps, helmet clink or ambience (NFR-SND-03): nothing here opens a sound.
 *
 * The facts, the window, the player and the timers are injected (the house idiom over `vi.mock`).
 */
import type { DepartureCause, DwarfId, MineId } from '@dwarfai/contracts'
import {
  computed,
  getCurrentScope,
  onScopeDispose,
  shallowRef,
  watch,
  type ComputedRef,
  type Ref
} from 'vue'
import {
  SETTLED,
  VETA_MOTION,
  stageChambers,
  stepChoreography,
  watchdogMs,
  type ArrivalWhere,
  type ChoreographyEffect,
  type ChoreographyEvent,
  type ChoreographyStep,
  type Leaving,
  type VetaChoreography
} from '../lib/veta/choreography'
import { isPresent, type VetaChamberView } from '../lib/veta/lifeState'
import type { VetaFact } from './useVetaLife'

/**
 * A motion the window plays. `mutate`, when given, changes the strip: the player measures what lies beyond first (FLIP),
 * calls it, lets the page draw it, then animates. Each resolves when its motion has ended, by any route.
 */
export type VetaCue =
  /** The island's parts fade in from the anchor side, 50 ms apart. */
  | { readonly kind: 'build'; readonly mutate?: () => void }
  /** A new chamber fades in from the anchor side; what lies beyond it slides by FLIP. */
  | { readonly kind: 'open-chamber'; readonly mineId: MineId; readonly mutate?: () => void }
  /** These dwarfs' buttons walk in from the chamber's far end, 70 ms apart (what lies beyond slides, if it widened). */
  | {
      readonly kind: 'walk-in'
      readonly mineId: MineId
      readonly dwarfIds: readonly DwarfId[]
      readonly mutate?: () => void
    }
  /** The dwarf's button turns and walks out away from the anchor, fading, held until removed. */
  | { readonly kind: 'walk-out'; readonly dwarfId: DwarfId; readonly mutate?: () => void }
  /** The emptied chamber fades out; then `mutate` removes it and what lay beyond slides back, when `slideBack`. */
  | {
      readonly kind: 'close-chamber'
      readonly mineId: MineId
      readonly slideBack: boolean
      readonly mutate?: () => void
    }
  /** The chamber narrowed: `mutate` removes the dwarf and what lies beyond it slides back. */
  | { readonly kind: 'slide-back'; readonly mineId: MineId; readonly mutate?: () => void }
  /** `mutate` contracts the strip to the closed entrance, which enters where it stands. */
  | { readonly kind: 'contract'; readonly mutate?: () => void }

export interface VetaChoreographyTimers {
  set(run: () => void, ms: number): unknown
  clear(handle: unknown): void
}

export interface VetaChoreographyDeps {
  /** The Host's chambers as they stand (`useVetaLife.chambers`). */
  facts(): readonly VetaChamberView[]
  /** The arrival and departure frames once drawn, and each snapshot (`useVetaLife.onFacts`). */
  onFacts(listener: (facts: readonly VetaFact[]) => void): () => void
  /** Veta is the shown mode window; reactive, so a hide mid-motion ends it (S26.13). */
  shown(): boolean
  /** No motion to play: reduced motion, or no Web Animations to play it with. */
  reduced(): boolean
  /** The mines whose chambers are drawn, not folded into "+N". */
  drawn(): readonly MineId[]
  /** A new chamber for this mine, with this many dwarfs, opens (S26.05) rather than folding into "+N" (S26.18). */
  opens(mineId: MineId, crew: number): boolean
  /** Places the window for the island these chambers draw, before they are drawn, when it is longer. */
  grow(chambers: readonly VetaChamberView[]): Promise<void>
  /** Places the window for the island as drawn now, once nothing moves. */
  shrink(): Promise<void>
  /** Measures the overflow at once: a mine folded into "+N" never shows its chamber first. */
  fold(): Promise<void>
  play(cue: VetaCue): Promise<void>
  /** Ends the motions in flight on these dwarfs' buttons, or on everything. */
  cancel(dwarfIds?: readonly DwarfId[]): void
  /** A departing dwarf's risen chat follows S24.10 / S24.11 for its cause. */
  chat(dwarfId: DwarfId, cause: DepartureCause): void
  /** The window's timers; its own by default. */
  timers?: VetaChoreographyTimers
}

/** A dwarf's walk: placed but not walked in yet, walking in, walking out. */
export type VetaWalk = 'waiting' | 'in' | 'out'

export interface VetaChoreographyPart {
  machine: Readonly<Ref<VetaChoreography>>
  /** The last step machine 26 took. */
  last: Readonly<Ref<ChoreographyStep | null>>
  /** The strip to draw: the facts, staged. */
  chambers: ComputedRef<readonly VetaChamberView[]>
  /** No chamber to draw: the closed entrance shows. */
  closed: ComputedRef<boolean>
  /** The entrance lamp has brightened (`lighting`). */
  lit: Readonly<Ref<boolean>>
  walking: Readonly<Ref<ReadonlyMap<DwarfId, VetaWalk>>>
  /** The dwarfs that walked in: their status sheets start from the top, `start-working` first. */
  arrived: Readonly<Ref<ReadonlySet<DwarfId>>>
  /** An arrival is held out of the strip, waiting for its turn. */
  holding: ComputedRef<boolean>
  /** A choreography runs or waits: the window is resized only by it meanwhile. */
  moving: ComputedRef<boolean>
  stop(): void
}

type Item =
  | { readonly kind: 'arrived'; readonly mineId: MineId; readonly dwarfIds: readonly DwarfId[] }
  | {
      readonly kind: 'departed'
      readonly dwarfId: DwarfId
      readonly mineId: MineId
      readonly cause: DepartureCause
    }

const WINDOW_TIMERS: VetaChoreographyTimers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

export function useVetaChoreography(deps: VetaChoreographyDeps): VetaChoreographyPart {
  const timers = deps.timers ?? WINDOW_TIMERS
  const machine = shallowRef<VetaChoreography>(SETTLED)
  const last = shallowRef<ChoreographyStep | null>(null)
  const hidden = shallowRef<ReadonlySet<DwarfId>>(new Set())
  const leaving = shallowRef<readonly Leaving[]>([])
  const lit = shallowRef(false)
  const walking = shallowRef<ReadonlyMap<DwarfId, VetaWalk>>(new Map())
  const arrived = shallowRef<ReadonlySet<DwarfId>>(new Set())
  const queue = shallowRef<readonly Item[]>([])
  /** A step's effects being carried out. */
  const carrying = shallowRef(false)

  const chambers = computed(() =>
    stageChambers(deps.facts(), { hidden: hidden.value, leaving: leaving.value })
  )
  const closed = computed(() => chambers.value.length === 0)
  const holding = computed(() => hidden.value.size > 0)
  const moving = computed(
    () => machine.value.state !== 'settled' || carrying.value || queue.value.length > 0
  )

  // Small immutable updates, so every change is one new value the page redraws from.
  const without = <T>(set: ReadonlySet<T>, ids: readonly T[]): ReadonlySet<T> =>
    new Set([...set].filter((id) => !ids.includes(id)))
  function walk(ids: readonly DwarfId[], to: VetaWalk | null): void {
    const next = new Map(walking.value)
    for (const id of ids) {
      if (to === null) next.delete(id)
      else next.set(id, to)
    }
    walking.value = next
  }
  function place(ids: readonly DwarfId[]): void {
    hidden.value = without(hidden.value, ids)
  }
  function unleave(ids: readonly DwarfId[]): void {
    leaving.value = leaving.value.filter((gone) => !ids.includes(gone.dwarf.id))
  }
  function landed(ids: readonly DwarfId[]): void {
    walk(ids, null)
    arrived.value = new Set([...arrived.value, ...ids])
  }

  /** Each step is stamped: the effects of a step a later one replaced stop where they are. */
  let stamp = 0
  let watchdog: unknown = null
  function disarm(): void {
    if (watchdog !== null) timers.clear(watchdog)
    watchdog = null
  }

  /** The walkers of the busiest chamber: walk-ins are 70 ms apart within a chamber, every chamber together. */
  function walkers(ids: readonly DwarfId[]): number {
    const perMine = new Map<MineId, number>()
    for (const chamber of chambers.value) {
      const count = chamber.dwarfs.filter((d) => ids.includes(d.id)).length
      if (count > 0) perMine.set(chamber.mine.id, count)
    }
    return Math.max(1, ...perMine.values())
  }

  function dispatch(event: ChoreographyEvent): ChoreographyStep {
    const before = machine.value
    const next = stepChoreography(before, event, { shown: deps.shown() })
    if (!next.step.ok) return next.step
    stamp += 1
    disarm()
    machine.value = next.machine
    last.value = next.step
    const to = next.machine
    if (to.state !== 'settled' && !deps.reduced()) {
      const mine = stamp
      // The parts once built, counted generously (each chamber, expand, the grip and "+N"): it is only a backstop.
      const placed = stageChambers(deps.facts(), {
        hidden: without(hidden.value, to.dwarfIds),
        leaving: leaving.value
      })
      const ms = watchdogMs(
        to.state,
        { parts: placed.length + 3, walkers: walkers(to.dwarfIds), last: to.last },
        false
      )
      watchdog = timers.set(() => {
        watchdog = null
        if (mine === stamp) dispatch({ type: 'watchdog' })
      }, ms)
    }
    void carry(next.step.effects, before, stamp)
    return next.step
  }

  /** A pause on the window's timers (the lamp's M). */
  function pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      timers.set(resolve, ms)
    })
  }

  async function carry(
    effects: readonly ChoreographyEffect[],
    before: VetaChoreography,
    mine: number
  ): Promise<void> {
    carrying.value = true
    try {
      for (const effect of effects) {
        await apply(effect, before)
        if (mine !== stamp) return
      }
      if (machine.value.state === 'settled') return
      // The state's motion has ended: on to the next state, or straight to the end state under reduced motion.
      dispatch({ type: deps.reduced() ? 'reduced' : 'done' })
    } finally {
      if (mine === stamp) {
        carrying.value = false
        if (machine.value.state === 'settled') pump()
      }
    }
  }

  /** The item in flight's dwarfs: the arrivals placed or the departure walking. */
  let current: Item | null = null

  async function apply(effect: ChoreographyEffect, before: VetaChoreography): Promise<void> {
    const still = deps.reduced()
    switch (effect.kind) {
      case 'grow': {
        const ids = current?.kind === 'arrived' ? current.dwarfIds : []
        const staged = stageChambers(deps.facts(), {
          hidden: without(hidden.value, ids),
          leaving: leaving.value
        })
        await deps.grow(staged)
        return
      }
      case 'light':
        if (still) return
        lit.value = true
        await pause(VETA_MOTION.lampMs)
        return
      case 'build': {
        const ids = machine.value.dwarfIds
        const mutate = (): void => {
          lit.value = false
          place(ids)
          walk(ids, 'waiting')
        }
        if (still) mutate()
        else await deps.play({ kind: 'build', mutate })
        return
      }
      case 'open-chamber': {
        const ids = machine.value.dwarfIds
        const mutate = (): void => {
          place(ids)
          walk(ids, 'waiting')
        }
        if (still) mutate()
        else await deps.play({ kind: 'open-chamber', mineId: effect.mineId, mutate })
        return
      }
      case 'walk-in': {
        const ids = effect.dwarfIds
        // Into a drawn chamber the dwarfs are placed now; from the entrance or a new chamber they wait in place.
        const placed = ids.every((id) => !hidden.value.has(id))
        const mutate = (): void => {
          if (!placed) place(ids)
          walk(ids, 'in')
        }
        if (still) mutate()
        else await deps.play({ kind: 'walk-in', mineId: effect.mineId, dwarfIds: ids, mutate })
        return
      }
      case 'status-sheet':
        landed(effect.dwarfIds)
        return
      case 'resolve-walk-in':
        deps.cancel(effect.dwarfIds)
        landed(effect.dwarfIds)
        return
      case 'chat':
        deps.chat(effect.dwarfId, effect.cause)
        return
      case 'walk-out':
        walk([effect.dwarfId], 'out')
        if (!still) await deps.play({ kind: 'walk-out', dwarfId: effect.dwarfId })
        return
      case 'close-chamber': {
        const ids = before.dwarfIds
        const mutate = (): void => {
          if (effect.slideBack) {
            unleave(ids)
            walk(ids, null)
          }
        }
        if (still) mutate()
        else
          await deps.play({
            kind: 'close-chamber',
            mineId: effect.mineId,
            slideBack: effect.slideBack,
            mutate
          })
        return
      }
      case 'slide-back': {
        const ids = before.dwarfIds
        const mutate = (): void => {
          unleave(ids)
          walk(ids, null)
        }
        if (still || before.mineId === null) mutate()
        else await deps.play({ kind: 'slide-back', mineId: before.mineId, mutate })
        return
      }
      case 'contract': {
        const ids = before.dwarfIds
        const mutate = (): void => {
          unleave(ids)
          walk(ids, null)
        }
        if (still) mutate()
        else await deps.play({ kind: 'contract', mutate })
        return
      }
      case 'shrink':
        await deps.shrink()
        return
      case 'commit':
        if (current?.kind === 'arrived') place(current.dwarfIds)
        else if (current?.kind === 'departed') unleave([current.dwarfId])
        return
      case 'fold':
        if (current?.kind === 'arrived') place(current.dwarfIds)
        await deps.fold()
        return
      case 'end-state': {
        deps.cancel()
        lit.value = false
        const ids = before.dwarfIds
        if (current?.kind === 'arrived') {
          place(ids)
          landed(ids)
        } else {
          unleave(ids)
          walk(ids, null)
        }
        return
      }
    }
  }

  /** Where an arrival lands, from the strip as it is drawn now. */
  function whereOf(mineId: MineId, crew: number): ArrivalWhere {
    const staged = chambers.value
    if (staged.length === 0) return 'closed'
    if (staged.some((c) => c.mine.id === mineId)) {
      return deps.drawn().includes(mineId) ? 'drawn' : 'folded'
    }
    return deps.opens(mineId, crew) ? 'new-chamber' : 'folded'
  }

  function eventOf(item: Item): ChoreographyEvent {
    if (item.kind === 'arrived') {
      return {
        type: 'arrived',
        mineId: item.mineId,
        dwarfIds: item.dwarfIds,
        where: whereOf(item.mineId, item.dwarfIds.length)
      }
    }
    const staged = chambers.value
    const own = staged.find((c) => c.mine.id === item.mineId)
    const emptied = own !== undefined && own.dwarfs.every((d) => d.id === item.dwarfId)
    return {
      type: 'departed',
      mineId: item.mineId,
      dwarfId: item.dwarfId,
      cause: item.cause,
      drawn: own !== undefined && deps.drawn().includes(item.mineId),
      emptied,
      last: emptied && staged.length === 1 && hidden.value.size === 0
    }
  }

  /** Takes the waiting items in order, one choreography at a time. */
  function pump(): void {
    while (machine.value.state === 'settled' && !carrying.value && queue.value.length > 0) {
      const [item, ...rest] = queue.value
      queue.value = rest
      current = item!
      const step = dispatch(eventOf(item!))
      // No choreography for it (a dwarf not drawn): the facts are drawn as they stand.
      if (!step.ok) {
        if (item!.kind === 'arrived') place(item!.dwarfIds)
        else unleave([item!.dwarfId])
      }
    }
  }

  /** Drops every hold: the facts are drawn as they stand, and whatever moved ends at once. */
  function reset(): void {
    stamp += 1
    disarm()
    if (machine.value.state !== 'settled') deps.cancel()
    machine.value = SETTLED
    queue.value = []
    hidden.value = new Set()
    leaving.value = []
    walking.value = new Map()
    lit.value = false
    carrying.value = false
    current = null
  }

  /** The staged strip before this batch changed the facts, rebuilt from the holds and the departures it brings. */
  let drawnBefore: readonly VetaChamberView[] = chambers.value
  watch(chambers, (now) => {
    drawnBefore = now
  })

  function hear(facts: readonly VetaFact[]): void {
    if (facts.some((f) => f.kind === 'snapshot')) {
      // A re-snapshot never walks anyone (S26.15): what is missing is gone, what is new stands at its station.
      reset()
      drawnBefore = chambers.value
      return
    }
    const shown = deps.shown()
    const items: Item[] = [...queue.value]
    for (const fact of facts) {
      if (fact.kind === 'arrived') {
        if (!isPresent(fact.dwarf)) continue
        const id = fact.dwarf.id
        const known = drawnBefore.some((c) => c.dwarfs.some((d) => d.id === id))
        if (known || hidden.value.has(id)) continue
        if (!shown) {
          // S26.16: no choreography; the settled layout is what the next show draws.
          current = { kind: 'arrived', mineId: fact.dwarf.mineId, dwarfIds: [id] }
          dispatch({ type: 'arrived', mineId: fact.dwarf.mineId, dwarfIds: [id], where: 'closed' })
          continue
        }
        hidden.value = new Set([...hidden.value, id])
        // Arrivals of one batch walk in together: those of one mine, or every one when the strip is closed.
        const together = items.findIndex(
          (item) =>
            item.kind === 'arrived' &&
            (item.mineId === fact.dwarf.mineId ||
              (drawnBefore.length === 0 && items.every((i) => i.kind === 'arrived')))
        )
        const batch = together >= 0 ? items[together] : undefined
        if (batch?.kind === 'arrived') {
          items[together] = { ...batch, dwarfIds: [...batch.dwarfIds, id] }
        } else {
          items.push({ kind: 'arrived', mineId: fact.dwarf.mineId, dwarfIds: [id] })
        }
        continue
      }
      if (fact.kind !== 'departed') continue
      const id = fact.dwarfId
      if (hidden.value.has(id)) {
        // It never showed: it leaves no walk behind.
        hidden.value = without(hidden.value, [id])
        for (let i = items.length - 1; i >= 0; i -= 1) {
          const item = items[i]!
          if (item.kind !== 'arrived' || !item.dwarfIds.includes(id)) continue
          const dwarfIds = item.dwarfIds.filter((d) => d !== id)
          if (dwarfIds.length === 0) items.splice(i, 1)
          else items[i] = { ...item, dwarfIds }
        }
        continue
      }
      const stood = drawnBefore.flatMap((c, chamberAt) =>
        c.dwarfs.flatMap((d, at) =>
          d.id === id ? [{ dwarf: d, mine: c.mine, chamberAt, at }] : []
        )
      )[0]
      if (!shown || stood === undefined) {
        current = { kind: 'departed', dwarfId: id, mineId: fact.mineId, cause: fact.cause }
        dispatch({
          type: 'departed',
          dwarfId: id,
          mineId: fact.mineId,
          cause: fact.cause,
          drawn: false,
          emptied: false,
          last: false
        })
        if (shown) deps.chat(id, fact.cause)
        continue
      }
      leaving.value = [...leaving.value.filter((gone) => gone.dwarf.id !== id), stood]
      const item: Item = { kind: 'departed', dwarfId: id, mineId: fact.mineId, cause: fact.cause }
      if (machine.value.state === 'walking-in' && machine.value.dwarfIds.includes(id)) {
        // S26.14: the walk-in resolves at once, then the walk-out plays.
        current = item
        dispatch(eventOf(item))
        continue
      }
      items.push(item)
    }
    queue.value = items
    drawnBefore = chambers.value
    pump()
  }

  // The window going hidden ends whatever moves (S26.13); what waits is drawn settled, with no choreography (S26.16).
  watch(
    () => deps.shown(),
    (shown) => {
      if (shown) return
      dispatch({ type: 'hidden' })
      const waiting = queue.value
      queue.value = []
      for (const item of waiting) {
        current = item
        dispatch(eventOf(item))
      }
      hidden.value = new Set()
      leaving.value = []
      walking.value = new Map()
    }
  )

  const unlisten = deps.onFacts(hear)
  function stop(): void {
    unlisten()
    disarm()
  }
  if (getCurrentScope() !== undefined) onScopeDispose(stop)

  return { machine, last, chambers, closed, lit, walking, arrived, holding, moving, stop }
}
