// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  DwarfId,
  DwarfWire,
  FolderPath,
  HostFrame,
  IpcResult,
  MineId,
  MineWire,
  SnapshotPage
} from '@dwarfai/contracts'
import { createFakeWindowApi } from '../../../contracts/ipc/testing/fakeWindowApi'
import { useDwarfRename } from './useDwarfRename'
import { useMines } from './useMines'

/*
 * WHO CAN BE RENAMED TODAY (BR-19; 21 §1 item 8, hidden until built; 14 §8 I-21).
 *
 * The rename rows `dwarf:setName` / `dwarf:resetName` stay `legacy` until the step-3a switch (ISSUE-001) routes their
 * Host successors A-N08 / A-N09, built by ISSUE-172. Today's runtime renames only the dwarfs on its own board, so a
 * dwarf the Host's board carries (a Host UUIDv7 id since the cut-1 switch) cannot be renamed by anything yet: its
 * Rename and Reset name are absent. A board still fed by today's runtime keeps them.
 */
describe('useDwarfRename', () => {
  type Api = Window['api']
  const ALPHA = '01920000-0000-7000-8000-00000000a001' as MineId
  const BORIN = '01920000-0000-7000-8000-00000000d001' as DwarfId

  const mineWire: MineWire = {
    id: ALPHA,
    path: '/work/alpha' as FolderPath,
    name: 'alpha',
    state: 'active',
    tier: 'bronze',
    hasBeenMeasured: true,
    lastUsedAt: 1,
    totals: {
      coal: { tokens: 0 },
      bronze: { tokens: 0 },
      copper: { tokens: 0 },
      silver: { tokens: 0 },
      gold: { tokens: 0 },
      uranium: { tokens: 0 }
    }
  }

  const borin = {
    id: BORIN,
    mineId: ALPHA,
    providerId: 'claude',
    baseName: 'Borin',
    customName: null,
    rank: 'foreman',
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
    owned: false,
    arrivedAt: 1
  } as DwarfWire

  const board: IpcResult<SnapshotPage> = {
    ok: true,
    value: {
      snapshotId: 'snap-1',
      seq: 1,
      epoch: 'epoch-1',
      chunks: [
        { section: 'mines', data: [mineWire] },
        { section: 'dwarfs', data: [borin] }
      ]
    }
  } as IpcResult<SnapshotPage>

  afterEach(() => {
    useMines().stop()
    delete (window as unknown as { api?: unknown }).api
  })

  it('[BR-19] offers no rename for a dwarf the Host’s board carries, which nothing can rename until step 3a', async () => {
    const api = createFakeWindowApi({
      getHostSnapshot: vi.fn().mockResolvedValue(board) as unknown as Api['getHostSnapshot'],
      onHostEvent: vi.fn(
        (_follow: (frames: HostFrame[]) => void) => () => undefined
      ) as unknown as Api['onHostEvent']
    })
    Object.defineProperty(window, 'api', { configurable: true, value: api })
    await expect(useMines().start()).resolves.toBe(true)
    expect(useDwarfRename().canRename(BORIN)).toBe(false)
  })

  it('[BR-19] keeps the rename for a dwarf only today’s runtime carries', () => {
    expect(useDwarfRename().canRename('d55')).toBe(true)
  })
})
