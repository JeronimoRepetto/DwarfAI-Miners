/*
 * The Veta window's life state (07 machine 20; UC-044; ADR-033 items 3, 5; ISSUE-287): its own read model of the
 * Host's `meta`, `mines` and `dwarfs` sections and their frames (one store set per window), relayed by UI main over
 * A-N01 `getHostSnapshot` and A-N02 `onHostEvent`, with the state `lib/veta/lifeState.ts` derives from them.
 *
 * - The read path is the house one (`followHost`): subscribe, then read the snapshot; a frame at or below the
 *   snapshot's `seq` is never applied twice; `resync-required` (Reset metrics among its reasons) or a new Host epoch
 *   reads a fresh snapshot, never a replay. A-N04 `connected` after any other state reads one too.
 * - Facts are followed whether or not Veta is the shown window; what arrives while it is hidden runs no choreography,
 *   and the next show renders the settled state (S20.17).
 * - `state` is `null` until the first snapshot: nothing is drawn before the Host has said anything.
 *
 * The overflow (07 machine 25; UC-049; ISSUE-291), carried out by `useVetaOverflow` over `lib/veta/overflow.ts`: which
 * run of chambers is drawn and which mines fold into "+N". A resize, an edge change or a chamber set change
 * re-measures, debounced (S25.03); a step that makes the island longer grows the window first (`grow`, which the root
 * sends as `layoutVeta {island-resize}`, S21.19), and the unfold for a reveal or a "+N" list-item click asks
 * `layoutVeta {unfold-overflow, mineId}` before the run shifts (S25.08, S25.11). Steps run one at a time, in order. A
 * measure that comes while the list shows waits until the pointer leaves it. The drawn set is what the root reports as
 * on screen (S25.10).
 *
 * The bridge, the window's visibility and the timers are injected (the house idiom over `vi.mock`).
 */
import type {
  DepartureCause,
  DwarfId,
  DwarfWire,
  VetaLayoutRequest,
  VetaLayoutResult,
  HostFrame,
  MineId,
  MineWire,
  MoveToModeParams,
  SnapshotChunk,
  SnapshotParams,
  SnapshotSection
} from '@dwarfai/contracts'
import { HOST_FRAME_SCHEMAS } from '@dwarfai/contracts'
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
  createVetaLife,
  type LifeStep,
  type VetaChamberView,
  type VetaFacts,
  type VetaLifeState,
  type VetaMineView
} from '../lib/veta/lifeState'
import {
  UNMEASURED,
  createRemeasure,
  drawnRun,
  stepOverflow,
  type OverflowEvent,
  type RemeasureTimers,
  type VetaOverflow
} from '../lib/veta/overflow'
import { createReadModel, followHost, type HostFollower } from './readModel'

/** The seam A members the life state reads (14 A-N01, A-N02, A-N04), and the move its entrance asks for (A-N13). */
export interface VetaLifeBridge {
  onHostEvent(listener: (frames: readonly HostFrame[]) => void): () => void
  getHostSnapshot(params: SnapshotParams): Promise<unknown>
  onHostConnection(listener: (view: unknown) => void): () => void
  moveToMode(params: MoveToModeParams): Promise<unknown>
}

/** Whether Veta is the shown mode window, and when that changes. */
export interface VetaVisibility {
  shown(): boolean
  onChange(listener: () => void): () => void
}

export interface VetaLifeDeps {
  bridge: VetaLifeBridge
  visibility: VetaVisibility
}

/**
 * What machine 26 hears (ISSUE-292; ADR-033 item 3): the `dwarf.arrived` and `dwarf.departed` frames, in order, once
 * the facts they changed are published, and a (re-)snapshot, which never walks anyone (S26.15).
 */
export type VetaFact =
  | { readonly kind: 'arrived'; readonly dwarf: DwarfWire }
  | {
      readonly kind: 'departed'
      readonly dwarfId: DwarfId
      readonly mineId: MineId
      readonly cause: DepartureCause
    }
  | { readonly kind: 'snapshot' }

export interface VetaLifePart {
  state: Readonly<Ref<VetaLifeState | null>>
  shown: Readonly<Ref<boolean>>
  /** The chambers to draw, in mine order. */
  chambers: Readonly<Ref<readonly VetaChamberView[]>>
  /** Every live mine with its present crew, in mine order: the mine picker's list (07 S22.07). */
  mines: Readonly<Ref<readonly VetaMineView[]>>
  /** The last step machine 20 took or refused. */
  last: Readonly<Ref<LifeStep | null>>
  /** Hears the arrival and departure frames once drawn, and each snapshot (machine 26's inputs). */
  onFacts(listener: (facts: readonly VetaFact[]) => void): () => void
  /** Follows the Host; answers whether the first snapshot was read. */
  start(): Promise<boolean>
  stop(): void
  /**
   * S20.12 and expand: the Panel, with no mine; a mine tab's "▢" (S23.04): the Panel on that mine (A-N13 `moveToMode`;
   * machine 27 runs the move).
   */
  openPanel(mineId?: MineId): void
}

/** The sections Veta reads (14 §6.4). */
const SECTIONS: SnapshotSection[] = ['meta', 'mines', 'dwarfs']

/** One snapshot's facts, all pages joined. */
function factsOf(chunks: readonly SnapshotChunk[]): VetaFacts {
  let minesEverKnown = false
  const mines: MineWire[] = []
  const dwarfs: DwarfWire[] = []
  for (const chunk of chunks) {
    if (chunk.section === 'meta') minesEverKnown = chunk.data.minesEverKnown
    else if (chunk.section === 'mines') mines.push(...chunk.data)
    else if (chunk.section === 'dwarfs') dwarfs.push(...chunk.data)
  }
  return { minesEverKnown, mines, dwarfs }
}

export function useVetaLife(deps: VetaLifeDeps): VetaLifePart {
  const life = createVetaLife()
  const state = shallowRef<VetaLifeState | null>(null)
  const shown = shallowRef(false)
  const chambers = shallowRef<readonly VetaChamberView[]>([])
  const last = shallowRef<LifeStep | null>(null)
  const mines = shallowRef<readonly VetaMineView[]>([])

  /** Machine 26's listeners, and the facts applied since the last publish (ISSUE-292). */
  const factListeners = new Set<(facts: readonly VetaFact[]) => void>()
  let heard: VetaFact[] = []

  function publish(): void {
    state.value = life.state
    shown.value = life.shown
    chambers.value = life.chambers
    mines.value = life.mines
    last.value = life.last
    if (heard.length === 0) return
    const facts = heard
    heard = []
    for (const listener of [...factListeners]) listener(facts)
  }

  /** An arrival or a departure the read model applied, in its 14 §3.5 shape. */
  function hear(frame: HostFrame): void {
    if (frame.name === 'dwarf.arrived') {
      const parsed = HOST_FRAME_SCHEMAS['dwarf.arrived'].safeParse(frame.data)
      if (parsed.success) heard.push({ kind: 'arrived', dwarf: parsed.data.dwarf as DwarfWire })
    } else if (frame.name === 'dwarf.departed') {
      const parsed = HOST_FRAME_SCHEMAS['dwarf.departed'].safeParse(frame.data)
      if (parsed.success) {
        const { dwarfId, mineId, cause } = parsed.data
        heard.push({
          kind: 'departed',
          dwarfId: dwarfId as DwarfId,
          mineId: mineId as MineId,
          cause
        })
      }
    }
  }

  function visibilityChanged(): void {
    if (deps.visibility.shown()) life.show()
    else life.hide()
    publish()
  }

  const model = createReadModel<VetaFacts, HostFrame>({
    state: { minesEverKnown: false, mines: [], dwarfs: [] },
    replace: (data) => {
      life.applySnapshot(data)
      // A snapshot supersedes whatever frames it holds: no walk (S26.15).
      heard = [{ kind: 'snapshot' }]
    },
    apply: (frame) => {
      life.applyFrame(frame)
      hear(frame)
    }
  })

  let follower: HostFollower | null = null
  let stopVisibility: (() => void) | null = null

  function stop(): void {
    follower?.stop()
    follower = null
    stopVisibility?.()
    stopVisibility = null
  }
  if (getCurrentScope() !== undefined) onScopeDispose(stop)

  return {
    state,
    shown,
    chambers,
    mines,
    last,
    onFacts(listener) {
      factListeners.add(listener)
      return () => factListeners.delete(listener)
    },
    async start() {
      stopVisibility ??= deps.visibility.onChange(visibilityChanged)
      visibilityChanged()
      follower ??= followHost(
        {
          subscribe: (listener) => deps.bridge.onHostEvent(listener),
          snapshot: (params) => deps.bridge.getHostSnapshot(params),
          connection: (listener) => deps.bridge.onHostConnection(listener)
        },
        { model, sections: SECTIONS, dataOf: factsOf, settled: publish }
      )
      const fed = await follower.start()
      publish()
      return fed
    },
    stop,
    openPanel(mineId) {
      const params: MoveToModeParams =
        mineId === undefined ? { mode: 'panel' } : { mode: 'panel', mineId }
      void deps.bridge.moveToMode(params).catch(() => {
        // UI main is unreachable: nothing moved, and the entrance stays where the person can try again.
      })
    }
  }
}

/** The seam A member the overflow uses (14 §2.2 A-N23 `unfold-overflow`). */
export interface VetaOverflowBridge {
  layoutVeta(request: VetaLayoutRequest): Promise<VetaLayoutResult>
}

export interface VetaOverflowDeps {
  bridge: VetaOverflowBridge
  /** Every chamber of a mine at work, in mine order. */
  chambers(): readonly VetaChamberView[]
  /** The stage's length along the edge, in CSS pixels; 0 when not known. */
  available(): number
  /** A left or right edge. */
  vertical(): boolean
  /** Grows the window for an island of this length, answered before the run changes (S21.19). */
  grow(length: number): Promise<void>
  /** The window's timers; its own by default. */
  timers?: RemeasureTimers
}

export interface VetaOverflowPart {
  machine: Readonly<Ref<VetaOverflow>>
  /** The chambers drawn: the visible run, in mine order. */
  drawn: ComputedRef<readonly VetaChamberView[]>
  /** The mines folded into "+N", in mine order. */
  folded: ComputedRef<readonly VetaChamberView[]>
  /** Asks for a measure (S25.01–S25.03), debounced. */
  remeasure(): void
  /** Measures at once: an arrival folded into "+N" (S26.18; ISSUE-292) never shows its chamber first. */
  measure(): Promise<void>
  /**
   * Fits the run to these chambers before they are drawn (ISSUE-292): an arrival's chamber that has no room folds into
   * "+N" in the same step as it is placed, never after the debounce. Measured from the design lengths alone.
   */
  measureFor(chambers: readonly VetaChamberView[]): Promise<void>
  /** A wheel notch over the strip (S25.04, S25.09). */
  wheel(delta: number): Promise<void>
  /** The pointer enters "+N" (S25.05) or leaves it and its list (S25.06). */
  enter(): Promise<void>
  leave(): Promise<void>
  /** Before a reveal: unfolds the mine's chamber when it is folded (S25.08). */
  reveal(mineId: MineId): Promise<void>
  /** A click on a "+N" list item (S25.11): answers whether its chamber unfolded. */
  pick(mineId: MineId): Promise<boolean>
  stop(): void
}

const WINDOW_TIMERS: RemeasureTimers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

export function useVetaOverflow(deps: VetaOverflowDeps): VetaOverflowPart {
  const machine = shallowRef<VetaOverflow>(UNMEASURED)
  const run = computed(() => drawnRun(machine.value, deps.chambers().length))
  const drawn = computed(() => {
    const { first, count } = run.value
    return deps.chambers().slice(first, first + count)
  })
  const folded = computed(() => {
    const { first, count } = run.value
    return deps.chambers().filter((_, at) => at < first || at >= first + count)
  })
  /** Steps run one at a time: each one's growth is answered before the next is decided. */
  let queue: Promise<unknown> = Promise.resolve()
  /** A measure refused while the list showed, owed once the pointer leaves. */
  let owed = false

  async function unfold(mineId: MineId): Promise<void> {
    try {
      await deps.bridge.layoutVeta({ kind: 'unfold-overflow', mineId })
    } catch {
      // UI main out of reach: the chamber unfolds in the window it has.
    }
  }

  function enqueue(event: OverflowEvent, upcoming?: readonly VetaChamberView[]): Promise<boolean> {
    const done = queue.then(async () => {
      const chambers = upcoming ?? deps.chambers()
      const next = stepOverflow(machine.value, event, {
        crews: chambers.map((chamber) => chamber.dwarfs.length),
        available: deps.available(),
        vertical: deps.vertical()
      })
      if (!next.step.ok) {
        if (event.type === 'measure') owed = true
        return false
      }
      // A pick hides the list at once; the unfold follows (S25.11).
      if (event.type === 'pick') machine.value = { ...machine.value, state: 'overflowing' }
      for (const effect of next.step.effects) {
        if (effect.kind === 'grow') await deps.grow(effect.length)
        else {
          const mine = chambers[effect.index]
          if (mine !== undefined) await unfold(mine.mine.id)
        }
      }
      machine.value = next.machine
      return true
    })
    queue = done.catch(() => undefined)
    return done
  }

  const remeasure = createRemeasure(deps.timers ?? WINDOW_TIMERS, () => {
    void enqueue({ type: 'measure' })
  })

  const indexOf = (mineId: MineId): number =>
    deps.chambers().findIndex((chamber) => chamber.mine.id === mineId)

  /** The first chambers are measured at once, as on a show (S25.01, S25.02); every change after, debounced. */
  let shownOnce = false
  // A chamber opening or closing, or a crew changing its length (S25.03).
  watch(
    () =>
      deps
        .chambers()
        .map((chamber) => `${chamber.mine.id}:${chamber.dwarfs.length}`)
        .join('|'),
    () => {
      if (shownOnce || deps.chambers().length === 0) {
        remeasure.request()
        return
      }
      shownOnce = true
      remeasure.cancel()
      void enqueue({ type: 'measure' })
    },
    { immediate: true }
  )
  if (getCurrentScope() !== undefined) onScopeDispose(() => remeasure.cancel())

  return {
    machine,
    drawn,
    folded,
    remeasure: () => remeasure.request(),
    async measure() {
      remeasure.cancel()
      await enqueue({ type: 'measure' })
    },
    async measureFor(chambers) {
      await enqueue({ type: 'measure' }, chambers)
    },
    wheel: async (delta) => {
      await enqueue({ type: 'wheel', delta })
    },
    enter: async () => {
      await enqueue({ type: 'enter' })
    },
    async leave() {
      await enqueue({ type: 'leave' })
      if (owed) {
        owed = false
        remeasure.request()
      }
    },
    async reveal(mineId) {
      const index = indexOf(mineId)
      if (index < 0 || !folded.value.some((chamber) => chamber.mine.id === mineId)) return
      if (machine.value.state === 'list-shown') await enqueue({ type: 'leave' })
      await enqueue({ type: 'reveal', index })
    },
    async pick(mineId) {
      const index = indexOf(mineId)
      if (index < 0) return false
      return enqueue({ type: 'pick', index })
    },
    stop: () => remeasure.cancel()
  }
}

/** The overflow over the page's own `window.api` (R13: `window.api` is read in composables only). */
export function useWindowVetaOverflow(deps: Omit<VetaOverflowDeps, 'bridge'>): VetaOverflowPart {
  return useVetaOverflow({ ...deps, bridge: window.api })
}

/** The life state over the page's own `window.api` and document (R13: `window.api` is read in composables only). */
export function useWindowVetaLife(): VetaLifePart {
  return useVetaLife({
    bridge: {
      onHostEvent: (listener) =>
        window.api.onHostEvent((frames) => listener(frames as unknown as readonly HostFrame[])),
      getHostSnapshot: (params) => window.api.getHostSnapshot(params),
      onHostConnection: (listener) => window.api.onHostConnection(listener),
      moveToMode: (params) => window.api.moveToMode(params)
    },
    visibility: {
      shown: () => document.visibilityState === 'visible',
      onChange(listener) {
        document.addEventListener('visibilitychange', listener)
        return () => document.removeEventListener('visibilitychange', listener)
      }
    }
  })
}
