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
 * WHERE A RENAME GOES (14 §2.2 A-N08 / A-N09, §8 I-21; ISSUE-172 lead decision, 2026-10-17).
 *
 * AMENDED for ISSUE-172 (was: a dwarf the Host's board carries could not be renamed until step 3a, BR-19). A-N08 and
 * A-N09 are routed `host` from cut 2: a dwarf the Host's board carries is renamed and reset by the Host (B-M22,
 * B-M23); a dwarf only today's runtime carries (a board fed by today's feed) keeps the legacy rows of 14 §8 I-21.
 * Every dwarf can be renamed.
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

  // AMENDED for ISSUE-172 (was: `[BR-19] offers no rename for a dwarf the Host’s board carries, which nothing can
  // rename until step 3a`, expecting `canRename` false): A-N08 is its destination now, so the gate is gone.
  it('[US-MSG-005.AC14, BR-19] a dwarf the Host’s board carries is renamed by the Host, never by today’s rows', async () => {
    const renameDwarf = vi
      .fn()
      .mockResolvedValue({ ok: true, value: { ok: true, value: { customName: 'Scout' } } })
    const setDwarfName = vi.fn()
    await hostBoard({
      renameDwarf: renameDwarf as unknown as Api['renameDwarf'],
      setDwarfName: setDwarfName as unknown as Api['setDwarfName']
    })
    await useDwarfRename().setName({ dwarfId: BORIN, name: 'Scout' })
    expect(renameDwarf).toHaveBeenCalledTimes(1)
    expect(setDwarfName).not.toHaveBeenCalled()
  })

  // AMENDED for ISSUE-172 (was: `canRename('d55')` true): with the Host feeding the board, a dwarf only today's
  // runtime carries still goes to today's rows.
  it('[BR-19] keeps the rename for a dwarf only today’s runtime carries', async () => {
    const setDwarfName = vi.fn().mockResolvedValue({ saved: true, customName: 'Watcher' })
    const resetDwarfNameToday = vi.fn().mockResolvedValue({ saved: true })
    const renameDwarf = vi.fn()
    await hostBoard({
      setDwarfName: setDwarfName as unknown as Api['setDwarfName'],
      resetDwarfNameToday: resetDwarfNameToday as unknown as Api['resetDwarfNameToday'],
      renameDwarf: renameDwarf as unknown as Api['renameDwarf']
    })
    const rename = useDwarfRename()
    await expect(rename.setName({ dwarfId: 'd55', name: 'Watcher' })).resolves.toEqual({
      saved: true,
      customName: 'Watcher'
    })
    await expect(rename.resetName('d55')).resolves.toEqual({ saved: true })
    expect(renameDwarf).not.toHaveBeenCalled()
  })

  // AMENDED for ISSUE-172 (was: `resetDwarfName`): today's reset member is `resetDwarfNameToday`, A-N09 having its
  // name.
  it('[ADR-033] renames and resets a dwarf through setDwarfName and resetDwarfName, answering main’s verdict', async () => {
    const setDwarfName = vi.fn().mockResolvedValue({ saved: true, customName: 'Watcher' })
    const resetDwarfName = vi.fn().mockResolvedValue({ saved: false, reason: 'gone' })
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: createFakeWindowApi({
        setDwarfName: setDwarfName as unknown as Api['setDwarfName'],
        resetDwarfNameToday: resetDwarfName as unknown as Api['resetDwarfNameToday']
      })
    })
    const rename = useDwarfRename()

    await expect(rename.setName({ dwarfId: 'd55', name: 'Watcher' })).resolves.toEqual({
      saved: true,
      customName: 'Watcher'
    })
    await expect(rename.resetName('d55')).resolves.toEqual({ saved: false, reason: 'gone' })
    expect(setDwarfName).toHaveBeenCalledWith({ dwarfId: 'd55', name: 'Watcher' })
    expect(resetDwarfName).toHaveBeenCalledWith('d55')
  })

  /** A Host-fed board carrying Borin, over a fake window.api with these A-N08 / A-N09 members. */
  async function hostBoard(members: Partial<Api>): Promise<void> {
    const api = createFakeWindowApi({
      getHostSnapshot: vi.fn().mockResolvedValue(board) as unknown as Api['getHostSnapshot'],
      onHostEvent: vi.fn(
        (_follow: (frames: HostFrame[]) => void) => () => undefined
      ) as unknown as Api['onHostEvent'],
      ...members
    })
    Object.defineProperty(window, 'api', { configurable: true, writable: true, value: api })
    await expect(useMines().start()).resolves.toBe(true)
  }

  it('[US-MSG-005.AC02, US-MSG-005.AC14] a dwarf the Host’s board carries is renamed through A-N08 with a fresh requestId, the Host’s stored name answered', async () => {
    const renameDwarf = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, value: { ok: true, value: { customName: 'Watcher' } } })
      .mockResolvedValueOnce({ ok: true, value: { ok: true, value: { customName: null } } })
    const setDwarfName = vi.fn()
    await hostBoard({
      renameDwarf: renameDwarf as unknown as Api['renameDwarf'],
      setDwarfName: setDwarfName as unknown as Api['setDwarfName']
    })
    const rename = useDwarfRename()

    await expect(rename.setName({ dwarfId: BORIN, name: 'Watcher' })).resolves.toEqual({
      saved: true,
      customName: 'Watcher'
    })
    // A name equal to the base name is the Host's reset (SC-AR-05): the base name shows again.
    await expect(rename.setName({ dwarfId: BORIN, name: 'Borin' })).resolves.toEqual({
      saved: true
    })
    const [first, second] = renameDwarf.mock.calls.map(([request]) => request)
    expect(first).toMatchObject({ dwarfId: BORIN, name: 'Watcher' })
    expect(second).toMatchObject({ dwarfId: BORIN, name: 'Borin' })
    expect(first.requestId).toMatch(/^[0-9a-f-]{36}$/)
    expect(first.requestId).not.toBe(second.requestId)
    expect(setDwarfName).not.toHaveBeenCalled()
  })

  it('[US-MSG-005.AC04, US-MSG-006.AC03] for a Host dwarf an empty save and Reset name go through A-N09, at once', async () => {
    const resetDwarfName = vi.fn().mockResolvedValue({ ok: true, value: undefined })
    const renameDwarf = vi.fn()
    await hostBoard({
      resetDwarfName: resetDwarfName as unknown as Api['resetDwarfName'],
      renameDwarf: renameDwarf as unknown as Api['renameDwarf']
    })
    const rename = useDwarfRename()

    await expect(rename.setName({ dwarfId: BORIN, name: '' })).resolves.toEqual({ saved: true })
    await expect(rename.resetName(BORIN)).resolves.toEqual({ saved: true })
    expect(resetDwarfName).toHaveBeenCalledTimes(2)
    expect(resetDwarfName.mock.calls[0]?.[0]).toMatchObject({ dwarfId: BORIN })
    expect(renameDwarf).not.toHaveBeenCalled()
  })

  it('[US-MSG-005.AC02] a Host rename or reset that stored nothing says today’s “The name could not be saved.”', async () => {
    const refused = {
      ok: false,
      error: { code: 'HOST_NOT_READY', message: 'starting', retryable: true }
    }
    const renameDwarf = vi
      .fn()
      .mockResolvedValueOnce(refused)
      .mockResolvedValueOnce({ ok: true, value: { ok: false, error: 'empty' } })
    const resetDwarfName = vi.fn().mockResolvedValue(refused)
    await hostBoard({
      renameDwarf: renameDwarf as unknown as Api['renameDwarf'],
      resetDwarfName: resetDwarfName as unknown as Api['resetDwarfName']
    })
    const rename = useDwarfRename()
    const notSaved = { saved: false, reason: 'The name could not be saved.' }

    await expect(rename.setName({ dwarfId: BORIN, name: 'Watcher' })).resolves.toEqual(notSaved)
    await expect(rename.setName({ dwarfId: BORIN, name: 'Watcher' })).resolves.toEqual(notSaved)
    await expect(rename.resetName(BORIN)).resolves.toEqual(notSaved)
  })
})
