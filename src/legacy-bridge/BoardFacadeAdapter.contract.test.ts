// layer: L6
import { describe, expect, it } from 'vitest'
import {
  CHANNELS,
  HOST_FRAME_SCHEMAS,
  snapshotChunkSchema,
  type DwarfId,
  type DwarfWire,
  type EvtFrame,
  type FolderPath,
  type MineId,
  type MineWire,
  type SnapshotChunk
} from '@dwarfai/contracts'
import type { HostClient, HostEvent } from '../ui-main/window/ports/hostClient'
import { createBoardFacadeAdapter } from './BoardFacadeAdapter'

// L6 (17 §1.6): every `MinesSnapshot` the facade produces — the A-12 `getMines` answer and each A-P2 `onMinesUpdated`
// push — is checked against the registry's today schema (`CHANNELS['mines:get'].response`,
// `CHANNELS['mines:update'].response`; ADR-001 item 2), for a board that holds every shape the Host's `mines` and
// `dwarfs` sections and the `mine.*` / `dwarf.*` frames can carry (14 §3.5, §3.6, §3.7). The Host is a scripted
// HostClient handing on the events of the port (window/ports/hostClient.ts); the macrotask is the test's. TC-086-01.

const EPOCH = 'epoch-0086'
const MINE_A = '01920000-0000-7000-9000-0000000a0001' as MineId
const MINE_B = '01920000-0000-7000-9000-0000000a0002' as MineId
const MINE_GONE = '01920000-0000-7000-9000-0000000a0003' as MineId
const id = (n: number) =>
  `01920000-0000-7000-9000-0000000d00${String(n).padStart(2, '0')}` as DwarfId

const zero = { tokens: 0 }
function mine(over: Partial<MineWire> & Pick<MineWire, 'id' | 'path' | 'name'>): MineWire {
  return {
    state: 'active',
    tier: 'gold',
    hasBeenMeasured: true,
    lastUsedAt: 1_700_000_000_000,
    totals: { coal: zero, bronze: zero, copper: zero, silver: zero, gold: zero, uranium: zero },
    ...over
  }
}

function dwarf(over: Partial<DwarfWire> & Pick<DwarfWire, 'id' | 'mineId'>): DwarfWire {
  return {
    providerId: 'claude',
    baseName: 'Dwarf',
    customName: null,
    rank: 'worker',
    parentDwarfId: null,
    delegated: false,
    sessionProfile: { providerId: over.providerId ?? 'claude' },
    presence: 'present',
    processState: 'running',
    status: 'working',
    needsYou: false,
    canReceiveMessages: true,
    stopInFlight: false,
    stopUnavailableReason: null,
    owned: false,
    arrivedAt: 1_700_000_000_500,
    ...over
  }
}

const MINES: MineWire[] = [
  mine({
    id: MINE_A,
    path: '/work/alpha' as FolderPath,
    name: 'alpha',
    mapSite: { xPct: 12.5, yPct: 40 },
    totals: {
      coal: { tokens: 120 },
      bronze: zero,
      copper: { tokens: 3_400 },
      silver: zero,
      gold: { tokens: 90_000 },
      uranium: zero
    }
  }),
  // A new mine is not measured yet: `tier` is null (06 INV-04, INV-05).
  mine({
    id: MINE_B,
    path: '/work/beta' as FolderPath,
    name: 'beta',
    state: 'unrecorded',
    tier: null,
    hasBeenMeasured: false
  })
]

const DWARFS: DwarfWire[] = [
  dwarf({
    id: id(1),
    mineId: MINE_A,
    rank: 'foreman',
    baseName: 'Thorin',
    customName: 'Lead',
    sessionProfile: { providerId: 'claude', model: 'opus', effort: 'high' },
    workplace: { path: '/work/alpha/wt' as FolderPath, branch: 'feat/x' },
    owned: true
  }),
  dwarf({
    id: id(2),
    mineId: MINE_A,
    providerId: 'codex',
    parentDwarfId: id(1),
    delegated: true,
    status: 'asking',
    needsYou: true,
    askedAt: 1_700_000_001_000
  }),
  dwarf({ id: id(3), mineId: MINE_A, providerId: 'antigravity', status: 'idle' }),
  dwarf({
    id: id(4),
    mineId: MINE_B,
    providerId: 'opencode',
    presence: 'resuming',
    status: 'asleep'
  }),
  dwarf({ id: id(5), mineId: MINE_B, presence: 'walking-out', status: 'idle' }),
  // A provider today's board has no identity for (open catalog, ADR-009 D2), and a dwarf of a mine not on the board.
  dwarf({ id: id(6), mineId: MINE_A, providerId: 'acme', sessionProfile: { providerId: 'acme' } }),
  dwarf({ id: id(7), mineId: MINE_GONE })
]

const chunks: SnapshotChunk[] = [
  {
    section: 'meta',
    data: {
      hostVersion: '0.0.0',
      state: 'ready',
      resetEpoch: 0,
      snapshotTail: 20,
      minesEverKnown: true
    }
  },
  { section: 'mines', data: MINES },
  { section: 'dwarfs', data: DWARFS }
]

let seq = 10
function frame<N extends keyof typeof HOST_FRAME_SCHEMAS>(name: N, data: unknown): EvtFrame {
  seq += 1
  // The fixture frames are the catalog's own (14 §1.4).
  HOST_FRAME_SCHEMAS[name].parse(data)
  return { type: 'evt', seq, epoch: EPOCH, name, data } as EvtFrame
}

/** The one HostClient member the facade reads, driven by the test. */
class ScriptedHost implements Pick<HostClient, 'subscribe'> {
  handler: ((event: HostEvent) => void) | null = null
  subscribe(handler: (event: HostEvent) => void): () => void {
    this.handler = handler
    return () => (this.handler = null)
  }
  emit(event: HostEvent): void {
    this.handler?.(event)
  }
}

describe('BoardFacadeAdapter: today’s MinesSnapshot (21 §3; 14 §5; ADR-001 item 2)', () => {
  it('[ADR-001] every MinesSnapshot the facade produces validates against today’s schema', () => {
    for (const chunk of chunks) snapshotChunkSchema.parse(chunk)
    const host = new ScriptedHost()
    const pushes: unknown[] = []
    const macrotasks: Array<() => void> = []
    const facade = createBoardFacadeAdapter({
      client: host,
      push: (board) => pushes.push(board),
      defer: (run) => macrotasks.push(run)
    })
    const read = CHANNELS['mines:get'].response
    const push = CHANNELS['mines:update'].response
    const produced: unknown[] = []
    const step = (event?: HostEvent): void => {
      if (event !== undefined) host.emit(event)
      for (const run of macrotasks.splice(0)) run()
      produced.push(facade.getMines())
    }

    // Before the first snapshot, after it, and after each frame kind the board folds.
    step()
    step({ kind: 'snapshot', snapshot: { snapshotId: 's-1', seq: 10, epoch: EPOCH, chunks } })
    step({
      kind: 'frame',
      frame: frame('mine.changed', {
        mine: { ...MINES[1], state: 'active', tier: 'uranium', hasBeenMeasured: true }
      })
    })
    step({
      kind: 'frame',
      frame: frame('dwarf.arrived', {
        dwarf: dwarf({ id: id(8), mineId: MINE_B, rank: 'worker2', baseName: 'Gimli' }),
        announce: true
      })
    })
    step({
      kind: 'frame',
      frame: frame('dwarf.changed', {
        dwarf: { ...DWARFS[2], status: 'working', customName: 'Scout' } as DwarfWire
      })
    })
    step({
      kind: 'frame',
      frame: frame('dwarf.departed', { dwarfId: id(1), mineId: MINE_A, cause: 'closed-elsewhere' })
    })

    expect(produced).toHaveLength(6)
    for (const board of produced) {
      expect(read.safeParse(board).error?.issues ?? []).toEqual([])
    }
    // One push per macrotask that changed the board: the snapshot and each of the four frames.
    expect(pushes).toHaveLength(5)
    for (const board of pushes) {
      expect(push.safeParse(board).error?.issues ?? []).toEqual([])
    }
    // The board is not empty: the schema check ran over the fixture world, not over nothing.
    const last = produced.at(-1) as { mines: Array<{ dwarfs: unknown[] }> }
    expect(last.mines).toHaveLength(2)
    expect(last.mines.flatMap((m) => m.dwarfs).length).toBeGreaterThan(0)
  })
})
