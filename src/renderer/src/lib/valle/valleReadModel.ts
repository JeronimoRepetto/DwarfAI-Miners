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
 * - The pins (07 machine 29; ISSUE-302) also hear each dwarf's open asks (the `asks` section, `ask.opened`,
 *   `ask.closed`), to read "! permission" or "? asking" (S29.15), and each departure with its cause and each mine's
 *   removal, observed after the snapshot (S29.13, S29.14).
 * - The needs-you queue (07 machine 34; ISSUE-306): the `asks` section's `needsYou`, the Host's `NeedsYouQueue`, taken
 *   as it comes, then patched in place by `ask.opened`, `ask.closed` and `dwarf.departed` through `needsYou.ts`: a new
 *   asker appended, an entry gone when its dwarf has no ask left, never re-sorted (ADR-032 D6; ADR-033 item 3).
 *
 * The bridge is injected (the house idiom over `vi.mock`); `main.ts` hands it the page's own `window.api`.
 */
import {
  HOST_FRAME_SCHEMAS,
  type AskRecord,
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
import { stepNeedsYou, type NeedsYouInput, type NeedsYouQueue } from './needsYou'

/** The seam A members the read models read (14 A-N01, A-N02, A-N04). */
export interface ValleReadModelBridge {
  onHostEvent(listener: (frames: readonly HostFrame[]) => void): () => void
  getHostSnapshot(params: SnapshotParams): Promise<unknown>
  onHostConnection(listener: (view: unknown) => void): () => void
}

/**
 * What the window hears once the facts it changed are published: an observed arrival or departure (`mineRemoved` for
 * the cause `mine-removed`), a mine's removal, or a (re-)snapshot.
 */
export type ValleFact =
  | { readonly kind: 'arrived'; readonly dwarf: DwarfWire; readonly announce: boolean }
  | {
      readonly kind: 'departed'
      readonly dwarfId: DwarfId
      readonly mineId: MineId
      readonly mineRemoved: boolean
    }
  | { readonly kind: 'mine-removed'; readonly mineId: MineId }
  | { readonly kind: 'snapshot' }

export interface ValleReadModel {
  /** Every live mine, in the Host's order. */
  mines: Readonly<Ref<readonly MineWire[]>>
  /** Every present dwarf, in the Host's order. */
  dwarfs: Readonly<Ref<readonly DwarfWire[]>>
  /** The Host connection is not `connected`: the facts are held as last known, read-only (S34.12). */
  held: Readonly<Ref<boolean>>
  /**
   * The Host's needs-you queue (14 §4.1 `asks` section `needsYou`; 07 machine 34; ISSUE-306): read as it comes and
   * patched in place by `ask.opened`, `ask.closed` and `dwarf.departed`, never re-sorted (ADR-032 D6, ADR-033 item 3).
   */
  needsYou: Readonly<Ref<NeedsYouQueue>>
  onFacts(listener: (facts: readonly ValleFact[]) => void): () => void
  /** The kind of a dwarf's oldest open ask, `null` with none (07 S29.15; ISSUE-302). */
  askOf(dwarfId: DwarfId): 'question' | 'permission' | null
  /** Follows the Host; answers whether the first snapshot was read. */
  start(): Promise<boolean>
  stop(): void
}

/** The sections Valle reads (14 §6.4). */
const SECTIONS: SnapshotSection[] = ['mines', 'dwarfs', 'asks']

/** An open ask, as the pins read it. */
interface OpenAsk {
  dwarfId: DwarfId
  kind: AskRecord['kind']
  openedAt: number
}

interface ValleFacts {
  mines: Map<MineId, MineWire>
  dwarfs: Map<DwarfId, DwarfWire>
  /** Open asks by ask id. */
  asks: Map<string, OpenAsk>
  /** The Host's needs-you queue, in its order. */
  queue: NeedsYouQueue
}

/** An ask still waiting for the person (ADR-010 item 5). */
const isOpen = (ask: AskRecord): boolean => ask.state === 'open' || ask.state === 'answering'

function factsOf(chunks: readonly SnapshotChunk[]): ValleFacts {
  const facts: ValleFacts = { mines: new Map(), dwarfs: new Map(), asks: new Map(), queue: [] }
  for (const chunk of chunks) {
    if (chunk.section === 'mines') for (const mine of chunk.data) facts.mines.set(mine.id, mine)
    else if (chunk.section === 'dwarfs') {
      for (const dwarf of chunk.data) facts.dwarfs.set(dwarf.id, dwarf as DwarfWire)
    } else if (chunk.section === 'asks') {
      facts.queue = chunk.data.needsYou as NeedsYouQueue
      for (const ask of chunk.data.asks) {
        if (isOpen(ask)) {
          facts.asks.set(ask.id, {
            dwarfId: ask.dwarfId as DwarfId,
            kind: ask.kind,
            openedAt: ask.openedAt
          })
        }
      }
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
  const facts: ValleFacts = { mines: new Map(), dwarfs: new Map(), asks: new Map(), queue: [] }
  const needsYou = shallowRef<NeedsYouQueue>([])

  /** Steps 07 machine 34 on the queue; a transition it does not list leaves the queue as it is (ADR-024). */
  function queue(input: NeedsYouInput): void {
    const step = stepNeedsYou(facts.queue, input)
    if (step.ok) facts.queue = step.queue
  }
  /** The `openedAt` of the dwarf's oldest open ask, `null` with none (S34.03, S34.04). */
  function nextAsk(dwarfId: DwarfId): number | null {
    let next: number | null = null
    for (const ask of facts.asks.values()) {
      if (ask.dwarfId === dwarfId && (next === null || ask.openedAt < next)) next = ask.openedAt
    }
    return next
  }

  /** Bumped on each publish, so a reader of `askOf` is told when the asks may have changed. */
  const published = shallowRef(0)

  function publish(): void {
    published.value += 1
    mines.value = [...facts.mines.values()]
    dwarfs.value = [...facts.dwarfs.values()]
    // The same array when no frame changed it: nothing redraws (NFR-PERF-03).
    needsYou.value = facts.queue
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
        if (!parsed.success) return
        facts.mines.delete(parsed.data.mineId)
        heard.push({ kind: 'mine-removed', mineId: parsed.data.mineId })
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
        if (!parsed.success) return
        const dwarfId = parsed.data.dwarfId as DwarfId
        facts.dwarfs.delete(dwarfId)
        for (const [askId, ask] of facts.asks) if (ask.dwarfId === dwarfId) facts.asks.delete(askId)
        queue({ kind: 'departed', dwarfId })
        heard.push({
          kind: 'departed',
          dwarfId,
          mineId: parsed.data.mineId as MineId,
          mineRemoved: parsed.data.cause === 'mine-removed'
        })
        return
      }
      case 'ask.opened': {
        const parsed = HOST_FRAME_SCHEMAS['ask.opened'].safeParse(frame.data)
        if (!parsed.success) return
        const ask = parsed.data.ask
        if (isOpen(ask)) {
          facts.asks.set(ask.id, {
            dwarfId: ask.dwarfId as DwarfId,
            kind: ask.kind,
            openedAt: ask.openedAt
          })
        } else facts.asks.delete(ask.id)
        // A dwarf the crew does not know has no mine to show it on: the Host gives it no entry either.
        const mineId = facts.dwarfs.get(ask.dwarfId as DwarfId)?.mineId
        if (mineId !== undefined) {
          queue({
            kind: 'ask-opened',
            dwarfId: ask.dwarfId as DwarfId,
            mineId,
            askedAt: ask.openedAt,
            state: ask.state
          })
        }
        return
      }
      case 'ask.closed': {
        const parsed = HOST_FRAME_SCHEMAS['ask.closed'].safeParse(frame.data)
        if (!parsed.success) return
        facts.asks.delete(parsed.data.askId)
        const dwarfId = parsed.data.dwarfId as DwarfId
        queue({ kind: 'ask-closed', dwarfId, next: nextAsk(dwarfId) })
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
      facts.asks = data.asks
      facts.queue = data.queue
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
    needsYou,
    askOf(dwarfId) {
      void published.value
      let oldest: OpenAsk | null = null
      for (const ask of facts.asks.values()) {
        if (ask.dwarfId === dwarfId && (oldest === null || ask.openedAt < oldest.openedAt))
          oldest = ask
      }
      return oldest?.kind ?? null
    },
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
