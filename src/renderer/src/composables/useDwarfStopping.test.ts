// @vitest-environment jsdom
/*
 * "Stop dwarf…" from the renderer (ISSUE-179 read side, ISSUE-001 part C; AMENDMENT-2, OQ-54; ADR-014; ADR-033 items 2,
 * 3). A-N29 `stopDwarf` relays B-M21 `crew.stop` unchanged (14 §2.2); its availability is the Host's
 * `DwarfWire.stopUnavailableReason` (INV-31), read off the board read model; the dwarf leaves the board only on
 * `dwarf.departed` (14 §4.3 rule 6). `useDwarfStopping` replaces `useDwarfKicking`, whose removal belongs to ISSUE-183.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'
import { stopDwarfParamsSchema } from '@dwarfai/contracts'
import type {
  DwarfId,
  DwarfWire,
  FolderPath,
  HostFrame,
  HostFrames,
  IpcResult,
  MineId,
  MineWire,
  SnapshotPage,
  StopUnavailableReason
} from '@dwarfai/contracts'
import { createFakeWindowApi } from '../../../contracts/ipc/testing/fakeWindowApi'
import { useDwarfStopping } from './useDwarfStopping'
import { useMines, type BoardWalk } from './useMines'

type Api = Window['api']
type StopAnswer = Awaited<ReturnType<Api['stopDwarf']>>

const EPOCH = 'epoch-1'
const ALPHA = '01920000-0000-7000-8000-00000000a001' as MineId
const BORIN = '01920000-0000-7000-8000-00000000d001' as DwarfId
const DAIN = '01920000-0000-7000-8000-00000000d002' as DwarfId
const REQUEST = '01928f3e-7a10-7b2c-8d3e-4f5a6b7c8d9e'

/** A board read model a test drives by hand: the Host's reason per dwarf. */
function fakeBoard(reasons: Record<string, StopUnavailableReason | null> = {}) {
  const held = reactive<Record<string, StopUnavailableReason | null>>({ ...reasons })
  return {
    held,
    stopUnavailableReason: (dwarfId: string) => held[dwarfId] ?? null
  }
}

/** A-N29 answering when the test says so. */
function deferredStop() {
  let answer: (result: StopAnswer) => void = () => undefined
  let fail: (error: unknown) => void = () => undefined
  const stopDwarf = vi.fn<Api['stopDwarf']>(
    () =>
      new Promise<StopAnswer>((resolve, reject) => {
        answer = resolve
        fail = reject
      })
  )
  return {
    stopDwarf,
    answer: (result: StopAnswer) => answer(result),
    fail: (error: unknown) => fail(error)
  }
}

function install(overrides: Partial<Api>): Api {
  const api = createFakeWindowApi(overrides)
  Object.defineProperty(window, 'api', { configurable: true, writable: true, value: api })
  return api
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

beforeEach(() => {
  useDwarfStopping().clearAll()
})

describe('useDwarfStopping', () => {
  it('[INV-31] Stop dwarf is disabled only while stopUnavailableReason is already-stopping', async () => {
    const board = fakeBoard({ [BORIN]: null, [DAIN]: 'already-stopping' })
    const host = deferredStop()
    install({ stopDwarf: host.stopDwarf })
    const stopping = useDwarfStopping({ readModel: board, newRequestId: () => REQUEST })
    expect(stopping.disabled(BORIN)).toBe(false)
    expect(stopping.disabled(DAIN)).toBe(true)

    // A request on its way does not disable it: only the Host's reason does (disabled, never hidden).
    void stopping.stop(BORIN)
    expect(stopping.viewOf(BORIN)).toEqual({ kind: 'request-sent' })
    expect(stopping.disabled(BORIN)).toBe(false)
    board.held[BORIN] = 'already-stopping'
    expect(stopping.disabled(BORIN)).toBe(true)
    board.held[DAIN] = null
    expect(stopping.disabled(DAIN)).toBe(false)
  })

  it('[ADR-033] a stop request shows request sent until the Host answers, and the walk-out waits for dwarf.departed', async () => {
    let listener: ((frames: HostFrame[]) => void) | null = null
    const frame = <F extends keyof HostFrames>(seq: number, name: F, data: HostFrames[F]) =>
      ({ type: 'evt', seq, epoch: EPOCH, name, data }) as HostFrame
    const mine = {
      id: ALPHA,
      path: '/work/alpha' as FolderPath,
      name: 'alpha',
      state: 'active',
      tier: 'bronze',
      hasBeenMeasured: true,
      lastUsedAt: 1,
      totals: Object.fromEntries(
        ['coal', 'bronze', 'copper', 'silver', 'gold', 'uranium'].map((m) => [m, { tokens: 0 }])
      )
    } as MineWire
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
      owned: true,
      arrivedAt: 1
    } as DwarfWire
    const snapshot: IpcResult<SnapshotPage> = {
      ok: true,
      value: {
        snapshotId: 'snap-3',
        seq: 3,
        epoch: EPOCH,
        chunks: [
          { section: 'mines', data: [mine] },
          { section: 'dwarfs', data: [borin] }
        ]
      }
    }
    const host = deferredStop()
    install({
      stopDwarf: host.stopDwarf,
      getHostSnapshot: (() => Promise.resolve(snapshot)) as unknown as Api['getHostSnapshot'],
      onHostEvent: ((follow: (frames: HostFrame[]) => void) => {
        listener = follow
        return () => {
          listener = null
        }
      }) as unknown as Api['onHostEvent']
    })
    const mines = useMines()
    mines.stop()
    const walks: BoardWalk[] = []
    const unwalk = mines.onWalk((walk) => walks.push(walk))
    try {
      await mines.start()
      await settle()
      const stopping = useDwarfStopping({ newRequestId: () => REQUEST })

      const sent = stopping.stop(BORIN)
      expect(host.stopDwarf).toHaveBeenCalledTimes(1)
      const request = host.stopDwarf.mock.calls[0]![0]
      expect(request).toEqual({ dwarfId: BORIN, requestId: REQUEST })
      expect(stopDwarfParamsSchema.safeParse(request).success).toBe(true)
      expect(stopping.viewOf(BORIN)).toEqual({ kind: 'request-sent' })

      host.answer({ ok: true, value: { ok: true, value: {} } })
      await sent
      // The Host answered: the request is no longer in flight, and nothing about the dwarf was assumed from it.
      expect(stopping.viewOf(BORIN)).toEqual({ kind: 'idle' })
      expect(mines.hostDwarfs().map((dwarf) => dwarf.id)).toEqual([BORIN])
      expect(walks).toEqual([])

      listener!([frame(4, 'dwarf.departed', { dwarfId: BORIN, mineId: ALPHA, cause: 'stopped' })])
      expect(walks).toEqual([
        { kind: 'walk-out', dwarfId: BORIN, mineId: ALPHA, cause: 'stopped', panel: 'read-only' }
      ])
    } finally {
      unwalk()
      mines.stop()
      mines.clear()
    }
  })

  it('[ADR-033] one press sends one request: a second press while it is on its way sends nothing', async () => {
    const host = deferredStop()
    install({ stopDwarf: host.stopDwarf })
    const stopping = useDwarfStopping({ readModel: fakeBoard(), newRequestId: () => REQUEST })
    const first = stopping.stop(BORIN)
    await stopping.stop(BORIN)
    expect(host.stopDwarf).toHaveBeenCalledTimes(1)
    host.answer({ ok: true, value: { ok: true, value: {} } })
    await first
    expect(stopping.viewOf(BORIN)).toEqual({ kind: 'idle' })
  })

  it("[ADR-033] the Host's refusal is shown as the Host stated it, until dismissed", async () => {
    const host = deferredStop()
    install({ stopDwarf: host.stopDwarf })
    const stopping = useDwarfStopping({ readModel: fakeBoard(), newRequestId: () => REQUEST })
    const sent = stopping.stop(BORIN)
    host.answer({ ok: true, value: { ok: false, error: 'could-not-end' } })
    await sent
    expect(stopping.viewOf(BORIN)).toEqual({ kind: 'refused', reason: 'could-not-end' })
    stopping.dismiss(BORIN)
    expect(stopping.viewOf(BORIN)).toEqual({ kind: 'idle' })
  })

  it('[ADR-033] an error answer or no answer claims nothing about the dwarf: the request is unanswered', async () => {
    const host = deferredStop()
    install({ stopDwarf: host.stopDwarf })
    const stopping = useDwarfStopping({ readModel: fakeBoard(), newRequestId: () => REQUEST })
    const refused = stopping.stop(BORIN)
    host.answer({
      ok: false,
      error: { code: 'INTERNAL', message: 'relay failed', retryable: false }
    } as StopAnswer)
    await refused
    expect(stopping.viewOf(BORIN)).toEqual({ kind: 'unanswered' })

    const lost = stopping.stop(DAIN)
    host.fail(new Error('the panel lost contact with UI main'))
    await lost
    expect(stopping.viewOf(DAIN)).toEqual({ kind: 'unanswered' })
  })
})
