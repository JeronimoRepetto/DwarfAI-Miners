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
 * The bridge and the window's visibility are injected (the house idiom over `vi.mock`).
 */
import type {
  DwarfWire,
  HostFrame,
  MineWire,
  MoveToModeParams,
  SnapshotChunk,
  SnapshotParams,
  SnapshotSection
} from '@dwarfai/contracts'
import { getCurrentScope, onScopeDispose, shallowRef, type Ref } from 'vue'
import {
  createVetaLife,
  type LifeStep,
  type VetaChamberView,
  type VetaFacts,
  type VetaLifeState,
  type VetaMineView
} from '../lib/veta/lifeState'
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

export interface VetaLifePart {
  state: Readonly<Ref<VetaLifeState | null>>
  shown: Readonly<Ref<boolean>>
  /** The chambers to draw, in mine order. */
  chambers: Readonly<Ref<readonly VetaChamberView[]>>
  /** Every live mine with its present crew, in mine order: the mine picker's list (07 S22.07). */
  mines: Readonly<Ref<readonly VetaMineView[]>>
  /** The last step machine 20 took or refused. */
  last: Readonly<Ref<LifeStep | null>>
  /** Follows the Host; answers whether the first snapshot was read. */
  start(): Promise<boolean>
  stop(): void
  /** S20.12 and expand: the Panel, with no mine (A-N13 `moveToMode`; machine 27 runs the move). */
  openPanel(): void
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

  function publish(): void {
    state.value = life.state
    shown.value = life.shown
    chambers.value = life.chambers
    mines.value = life.mines
    last.value = life.last
  }

  function visibilityChanged(): void {
    if (deps.visibility.shown()) life.show()
    else life.hide()
    publish()
  }

  const model = createReadModel<VetaFacts, HostFrame>({
    state: { minesEverKnown: false, mines: [], dwarfs: [] },
    replace: (data) => life.applySnapshot(data),
    apply: (frame) => life.applyFrame(frame)
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
    openPanel() {
      void deps.bridge.moveToMode({ mode: 'panel' }).catch(() => {
        // UI main is unreachable: nothing moved, and the entrance stays where the person can try again.
      })
    }
  }
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
