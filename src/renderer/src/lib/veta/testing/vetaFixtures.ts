/*
 * Fixture snapshots and frames for the Veta tests (ISSUE-287; 17 §2.2): wire records in the 14 §3.6 shapes, a snapshot
 * page of the `meta`, `mines` and `dwarfs` sections, and frames as UI main relays them over A-N02. Never imported by
 * production code (R14).
 */
import type {
  DwarfId,
  DwarfWire,
  FolderPath,
  HostFrame,
  HostFrames,
  IpcResult,
  MineId,
  MineWire,
  SnapshotPage
} from '@dwarfai/contracts'

export const EPOCH = 'epoch-veta'

export const MORIA = '01920000-0000-7000-8000-00000000a001' as MineId
export const EREBOR = '01920000-0000-7000-8000-00000000a002' as MineId
export const KHAZAD = '01920000-0000-7000-8000-00000000a003' as MineId

export const BORIN = '01920000-0000-7000-8000-00000000d001' as DwarfId
export const DAIN = '01920000-0000-7000-8000-00000000d002' as DwarfId
export const NALI = '01920000-0000-7000-8000-00000000d003' as DwarfId

const NAMES: Readonly<Record<string, string>> = {
  [MORIA]: 'moria',
  [EREBOR]: 'erebor',
  [KHAZAD]: 'khazad'
}

export function mineWire(id: MineId, overrides: Partial<MineWire> = {}): MineWire {
  return {
    id,
    path: `/work/${NAMES[id] ?? 'mine'}` as FolderPath,
    name: NAMES[id] ?? 'mine',
    state: 'active',
    tier: 'silver',
    hasBeenMeasured: true,
    lastUsedAt: 1,
    totals: {
      coal: { tokens: 0 },
      bronze: { tokens: 0 },
      copper: { tokens: 0 },
      silver: { tokens: 0 },
      gold: { tokens: 0 },
      uranium: { tokens: 0 }
    },
    ...overrides
  }
}

export function dwarfWire(
  id: DwarfId,
  mineId: MineId,
  overrides: Partial<DwarfWire> = {}
): DwarfWire {
  return {
    id,
    mineId,
    providerId: 'claude',
    baseName: id === BORIN ? 'borin' : id === DAIN ? 'dain' : 'nali',
    customName: null,
    rank: 'worker',
    parentDwarfId: null,
    delegated: false,
    sessionProfile: { providerId: 'claude' },
    presence: 'present',
    processState: 'running',
    status: 'idle',
    needsYou: false,
    canReceiveMessages: true,
    stopInFlight: false,
    stopUnavailableReason: null,
    owned: true,
    arrivedAt: 1,
    ...overrides
  } as DwarfWire
}

/** What one snapshot of the Veta sections holds. */
export interface VetaSnapshotData {
  minesEverKnown: boolean
  mines: MineWire[]
  dwarfs: DwarfWire[]
}

/** A one-page snapshot answer of the `meta`, `mines` and `dwarfs` sections (A-N01). */
export function snapshotPage(
  seq: number,
  data: VetaSnapshotData,
  epoch = EPOCH
): IpcResult<SnapshotPage> {
  return {
    ok: true,
    value: {
      snapshotId: `snap-${seq}`,
      seq,
      epoch,
      chunks: [
        {
          section: 'meta',
          data: {
            hostVersion: '0.20.0',
            state: 'ready',
            resetEpoch: 0,
            snapshotTail: 20,
            minesEverKnown: data.minesEverKnown
          }
        },
        { section: 'mines', data: data.mines },
        { section: 'dwarfs', data: data.dwarfs }
      ]
    }
  }
}

/** One frame as UI main relays it (A-N02). */
export function frame<F extends keyof HostFrames>(
  seq: number,
  name: F,
  data: HostFrames[F],
  epoch = EPOCH
): HostFrame {
  return { type: 'evt', seq, epoch, name, data } as HostFrame
}
