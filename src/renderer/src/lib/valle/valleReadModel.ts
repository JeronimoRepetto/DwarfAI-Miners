/*
 * The Valle read-model roots (ADR-033 items 3, 5: one store set per window; UC-067, the Valle half; 07 S34.12, S29.02;
 * ISSUE-299): the Valle window's own read model of the Host's `mines` and `dwarfs` sections and their frames, relayed
 * by UI main over A-N01 `getHostSnapshot` and A-N02 `onHostEvent`, on the house read path (`followHost`).
 *
 * - The Host connection lost (ADR-002 D9; ADR-033 item 3): while A-N04 says anything but `connected` the read models are
 *   `held` as last known, read-only; nothing is cleared and no dwarf is dropped. The persisted stores (pins among them)
 *   are UI main's and never depend on the Host. `connected` again reads a fresh snapshot.
 * - A snapshot, the first or a re-snapshot, replaces the facts whole and is heard as one `snapshot` fact: no arrival, no
 *   departure, so nothing walks and no toast shows for it (S34.12, S29.02). Only a frame newer than the snapshot is an
 *   observed fact (`arrived`, with the Host's `announce`), which the arrival toast hears (S39.11).
 *
 * The bridge is injected (the house idiom over `vi.mock`); `main.ts` hands it the page's own `window.api`.
 */
import {
  HOST_FRAME_SCHEMAS,
  hostConnectionViewSchema,
  type DwarfId,
  type DwarfWire,
  type HostFrame,
  type MineId,
  type MineWire,
  type SnapshotChunk,
  type SnapshotParams,
  type SnapshotSection
} from '@dwarfai/contracts'
import { getCurrentScope, onScopeDispose, shallowRef, type Ref } from 'vue'
import { createReadModel, followHost, type HostFollower } from '../../composables/readModel'

/** The seam A members the read models read (14 A-N01, A-N02, A-N04). */
export interface ValleReadModelBridge {
  onHostEvent(listener: (frames: readonly HostFrame[]) => void): () => void
  getHostSnapshot(params: SnapshotParams): Promise<unknown>
  onHostConnection(listener: (view: unknown) => void): () => void
}

/** What the window hears once the facts it changed are published: an observed arrival, or a (re-)snapshot. */
export type ValleFact =
  | { readonly kind: 'arrived'; readonly dwarf: DwarfWire; readonly announce: boolean }
  | { readonly kind: 'snapshot' }

export interface ValleReadModel {
  /** Every live mine, in the Host's order. */
  mines: Readonly<Ref<readonly MineWire[]>>
  /** Every present dwarf, in the Host's order. */
  dwarfs: Readonly<Ref<readonly DwarfWire[]>>
  /** The Host connection is not `connected`: the facts are held as last known, read-only (S34.12). */
  held: Readonly<Ref<boolean>>
  onFacts(listener: (facts: readonly ValleFact[]) => void): () => void
  /** Follows the Host; answers whether the first snapshot was read. */
  start(): Promise<boolean>
  stop(): void
}

/** The sections Valle reads (14 §6.4). */
const SECTIONS: SnapshotSection[] = ['mines', 'dwarfs']

interface ValleFacts {
  mines: Map<MineId, MineWire>
  dwarfs: Map<DwarfId, DwarfWire>
}

function factsOf(chunks: readonly SnapshotChunk[]): ValleFacts {
  const facts: ValleFacts = { mines: new Map(), dwarfs: new Map() }
  for (const chunk of chunks) {
    if (chunk.section === 'mines') for (const mine of chunk.data) facts.mines.set(mine.id, mine)
    else if (chunk.section === 'dwarfs') {
      for (const dwarf of chunk.data) facts.dwarfs.set(dwarf.id, dwarf as DwarfWire)
    }
  }
  return facts
}

export function createValleReadModel(bridge: ValleReadModelBridge): ValleReadModel {
  const mines = shallowRef<readonly MineWire[]>([])
  const dwarfs = shallowRef<readonly DwarfWire[]>([])
  const held = shallowRef(false)
  const listeners = new Set<(facts: readonly ValleFact[]) => void>()
  let heard: ValleFact[] = []
  const facts: ValleFacts = { mines: new Map(), dwarfs: new Map() }

  function publish(): void {
    mines.value = [...facts.mines.values()]
    dwarfs.value = [...facts.dwarfs.values()]
    if (heard.length === 0) return
    const batch = heard
    heard = []
    for (const listener of [...listeners]) listener(batch)
  }

  /** Applies one frame newer than the snapshot; a frame whose data is not its 14 §3.5 payload is ignored. */
  function apply(frame: HostFrame): void {
    switch (frame.name) {
      case 'mine.changed': {
        const parsed = HOST_FRAME_SCHEMAS['mine.changed'].safeParse(frame.data)
        if (parsed.success) facts.mines.set(parsed.data.mine.id, parsed.data.mine)
        return
      }
      case 'mine.removed': {
        const parsed = HOST_FRAME_SCHEMAS['mine.removed'].safeParse(frame.data)
        if (parsed.success) facts.mines.delete(parsed.data.mineId)
        return
      }
      case 'dwarf.arrived': {
        const parsed = HOST_FRAME_SCHEMAS['dwarf.arrived'].safeParse(frame.data)
        if (!parsed.success) return
        const dwarf = parsed.data.dwarf as DwarfWire
        const known = facts.dwarfs.has(dwarf.id)
        facts.dwarfs.set(dwarf.id, dwarf)
        if (!known) heard.push({ kind: 'arrived', dwarf, announce: parsed.data.announce })
        return
      }
      case 'dwarf.changed': {
        const parsed = HOST_FRAME_SCHEMAS['dwarf.changed'].safeParse(frame.data)
        if (parsed.success && facts.dwarfs.has(parsed.data.dwarf.id as DwarfId)) {
          facts.dwarfs.set(parsed.data.dwarf.id as DwarfId, parsed.data.dwarf as DwarfWire)
        }
        return
      }
      case 'dwarf.departed': {
        const parsed = HOST_FRAME_SCHEMAS['dwarf.departed'].safeParse(frame.data)
        if (parsed.success) facts.dwarfs.delete(parsed.data.dwarfId as DwarfId)
        return
      }
      default:
        return
    }
  }

  const model = createReadModel<ValleFacts, HostFrame>({
    state: facts,
    replace: (data) => {
      facts.mines = data.mines
      facts.dwarfs = data.dwarfs
      // A snapshot supersedes whatever frames it holds: nothing walks, nothing is announced (S34.12).
      heard = [{ kind: 'snapshot' }]
    },
    apply
  })

  let follower: HostFollower | null = null
  let stopConnection: (() => void) | null = null
  function connectionChanged(view: unknown): void {
    const parsed = hostConnectionViewSchema.safeParse(view)
    if (parsed.success) held.value = parsed.data.state !== 'connected'
  }

  function stop(): void {
    follower?.stop()
    follower = null
    stopConnection?.()
    stopConnection = null
  }
  if (getCurrentScope() !== undefined) onScopeDispose(stop)

  return {
    mines,
    dwarfs,
    held,
    onFacts(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async start() {
      stopConnection ??= bridge.onHostConnection(connectionChanged)
      follower ??= followHost(
        {
          subscribe: (listener) => bridge.onHostEvent(listener),
          snapshot: (params) => bridge.getHostSnapshot(params),
          connection: (listener) => bridge.onHostConnection(listener)
        },
        { model, sections: SECTIONS, dataOf: factsOf, settled: publish }
      )
      const fed = await follower.start()
      publish()
      return fed
    },
    stop
  }
}
