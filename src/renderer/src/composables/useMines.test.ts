// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  DepartureCause,
  DwarfId,
  DwarfWire,
  FolderPath,
  HostFrame,
  HostFrames,
  IpcResult,
  MineId,
  MineWire,
  SnapshotPage,
  SnapshotParams
} from '@dwarfai/contracts'
import { createFakeWindowApi } from '../../../contracts/ipc/testing/fakeWindowApi'
import { sessionClosed } from '../lib/delivery/actionBar'
import { dwarfTip } from '../lib/dwarf/dwarfTip'
import { sceneDwarfStatus } from '../lib/scene/sceneDwarf'
import { publishBoard } from '../testing/board'
import { defaultMaterials, defaultMine } from '../testing/factories'
import { useMines, type BoardWalk } from './useMines'
import { useToasts } from './useToasts'

/*
 * The board's own reset (AMENDED for ISSUE-242, cut 5: was `useMines arrivals`, `useMines` and `useMines global vault`
 * over `setMines`, today's A-12/A-P2 feed, deleted with `BoardFacadeAdapter`; arrivals and totals are the Host read
 * model's below, `[US-MINE-009.AC02, S2.02]` and the snapshot tests).
 */
describe('useMines', () => {
  it('clears the mines list, the vault total and its breakdown', () => {
    const { state, clear } = useMines()
    publishBoard({
      mines: [defaultMine()],
      tokensObserved: 42,
      materials: defaultMaterials({ bronze: 20_000 })
    })
    clear()
    expect(state.mines).toEqual([])
    expect(state.tokensObserved).toBe(0)
    expect(state.materials).toBeUndefined()
  })
})

/*
 * THE BOARD FROM THE HOST (ISSUE-092; ADR-033 item 3; 14 §4.3, §6.4 row `useMines`).
 *
 * The board becomes a read model of A-N01 `getHostSnapshot` and A-N02 `onHostEvent`: subscribe first, read the
 * snapshot, then apply only the frames newer than it. A departure is an event, never a difference between two
 * snapshots (14 §4.3 rule 6). Tested against the generated fake `window.api` with scripted frames (ADR-033 item 7).
 */
describe('useMines from the Host read model', () => {
  type Api = Window['api']
  type SnapshotAnswer = IpcResult<SnapshotPage>

  const EPOCH = 'epoch-1'
  const ALPHA = '01920000-0000-7000-8000-00000000a001' as MineId
  const BORIN = '01920000-0000-7000-8000-00000000d001' as DwarfId
  const DAIN = '01920000-0000-7000-8000-00000000d002' as DwarfId

  function mineWire(overrides: Partial<MineWire> = {}): MineWire {
    return {
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
      },
      ...overrides
    }
  }

  function dwarfWire(id: DwarfId, overrides: Partial<DwarfWire> = {}): DwarfWire {
    return {
      id,
      mineId: ALPHA,
      providerId: 'claude',
      baseName: id === BORIN ? 'Borin' : 'Dain',
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
      arrivedAt: 1,
      ...overrides
    } as DwarfWire
  }

  function page(seq: number, mines: MineWire[], dwarfs: DwarfWire[]): SnapshotAnswer {
    return {
      ok: true,
      value: {
        snapshotId: `snap-${seq}`,
        seq,
        epoch: EPOCH,
        chunks: [
          { section: 'mines', data: mines },
          { section: 'dwarfs', data: dwarfs }
        ]
      }
    }
  }

  function frame<F extends keyof HostFrames>(
    seq: number,
    name: F,
    data: HostFrames[F],
    epoch = EPOCH
  ): HostFrame {
    return { type: 'evt', seq, epoch, name, data } as HostFrame
  }

  interface Host {
    /** A-N02: one batch of frames, as UI main relays them. */
    push(frames: HostFrame[]): void
    /** Every A-N01 request, in order. */
    requests: SnapshotParams[]
  }

  /**
   * The fake `window.api` with A-N01 answering each scripted answer in turn (the last one repeats) and A-N02
   * scripted by the test. An answer may be a function, to push frames while the snapshot is being read.
   */
  function installHost(answers: Array<SnapshotAnswer | (() => SnapshotAnswer)>): Host {
    let listener: ((frames: HostFrame[]) => void) | null = null
    const requests: SnapshotParams[] = []
    let next = 0
    const api = createFakeWindowApi({
      getHostSnapshot: vi.fn((request: SnapshotParams) => {
        requests.push(request)
        const answer = answers[Math.min(next, answers.length - 1)]!
        next += 1
        return Promise.resolve(typeof answer === 'function' ? answer() : answer)
      }) as unknown as Api['getHostSnapshot'],
      onHostEvent: vi.fn((follow: (frames: HostFrame[]) => void) => {
        listener = follow
        return () => {
          listener = null
        }
      }) as unknown as Api['onHostEvent']
    })
    Object.defineProperty(window, 'api', { configurable: true, writable: true, value: api })
    return {
      push(frames) {
        if (listener === null) throw new Error('nothing follows onHostEvent')
        listener(frames)
      },
      requests
    }
  }

  async function settle(): Promise<void> {
    for (let i = 0; i < 10; i += 1) await Promise.resolve()
  }

  const stopRecording: Array<() => void> = []

  /** Every walk the read model emits, from now on. */
  function recordWalks(): BoardWalk[] {
    const walks: BoardWalk[] = []
    stopRecording.push(useMines().onWalk((walk) => walks.push(walk)))
    return walks
  }

  function forgetWalks(): void {
    for (const stop of stopRecording.splice(0)) stop()
  }

  const boardDwarfs = () => useMines().state.mines.flatMap((mine) => mine.dwarfs)

  beforeEach(() => {
    vi.useFakeTimers()
    useMines().stop()
    useMines().clear()
  })

  afterEach(() => {
    forgetWalks()
    useMines().stop()
    useMines().clear()
    vi.runAllTimers()
    vi.useRealTimers()
  })

  it('[US-MINE-009.AC01, S2.03] opening a mine whose dwarfs are already present emits no walk-in', async () => {
    installHost([page(3, [mineWire()], [dwarfWire(BORIN), dwarfWire(DAIN)])])
    const walks = recordWalks()
    await useMines().start()
    await settle()
    expect(boardDwarfs().map((dwarf) => dwarf.id)).toEqual([BORIN, DAIN])
    expect(walks).toEqual([])
    expect([...useMines().state.arrived]).toEqual([])
  })

  it('[US-MINE-009.AC02, S2.02] a dwarf.arrived frame for the open mine emits one walk-in', async () => {
    const host = installHost([page(3, [mineWire()], [dwarfWire(BORIN)])])
    const walks = recordWalks()
    await useMines().start()
    host.push([frame(4, 'dwarf.arrived', { dwarf: dwarfWire(DAIN), announce: false })])
    expect(walks).toEqual([{ kind: 'walk-in', dwarfId: DAIN, mineId: ALPHA }])
    expect([...useMines().state.arrived]).toEqual([DAIN])
    expect(boardDwarfs().map((dwarf) => dwarf.id)).toEqual([BORIN, DAIN])
  })

  it('[US-MINE-009.AC03] a dwarf.departed frame emits one walk-out whatever its cause', async () => {
    const causes: DepartureCause[] = ['stopped', 'closed-elsewhere', 'crashed', 'mine-removed']
    for (const cause of causes) {
      useMines().stop()
      const host = installHost([page(3, [mineWire()], [dwarfWire(BORIN)])])
      const walks = recordWalks()
      await useMines().start()
      host.push([frame(4, 'dwarf.departed', { dwarfId: BORIN, mineId: ALPHA, cause })])
      expect(walks).toHaveLength(1)
      expect(walks[0]).toMatchObject({ kind: 'walk-out', dwarfId: BORIN, mineId: ALPHA, cause })
      // It walks out on the board (today's 'leaving'), then its sprite is dropped (S2.17).
      expect(boardDwarfs().map((dwarf) => [dwarf.id, dwarf.status])).toEqual([[BORIN, 'leaving']])
      vi.runAllTimers()
      expect(boardDwarfs()).toEqual([])
      forgetWalks()
    }
  })

  it('[US-MINE-009.AC04, S2.16] a dwarf missing from a re-snapshot disappears with no walk-out and silence never removes one', async () => {
    const host = installHost([
      page(3, [mineWire()], [dwarfWire(BORIN), dwarfWire(DAIN)]),
      page(9, [mineWire()], [dwarfWire(BORIN)])
    ])
    const walks = recordWalks()
    await useMines().start()
    // Silence: a day without a frame removes nobody.
    vi.advanceTimersByTime(24 * 60 * 60 * 1000)
    expect(boardDwarfs().map((dwarf) => dwarf.id)).toEqual([BORIN, DAIN])
    // A re-snapshot that lacks Dain drops him silently.
    host.push([frame(4, 'resync-required', { reason: 'ring-overrun' })])
    await settle()
    expect(boardDwarfs().map((dwarf) => dwarf.id)).toEqual([BORIN])
    expect(walks).toEqual([])
  })

  it('[US-OBS-002.AC07] an announce arrival raises the toast "<d> started in <name>" in the Panel', async () => {
    const host = installHost([page(3, [mineWire()], [])])
    await useMines().start()
    const { toasts } = useToasts()
    host.push([frame(4, 'dwarf.arrived', { dwarf: dwarfWire(DAIN), announce: false })])
    expect(toasts.value.map((toast) => toast.text)).not.toContain('Dain started in alpha')
    host.push([
      frame(5, 'dwarf.arrived', {
        dwarf: dwarfWire(BORIN, { customName: 'Old Borin' }),
        announce: true
      })
    ])
    expect(toasts.value.map((toast) => toast.text)).toContain('Old Borin started in alpha')
  })

  it("[US-OBS-005.AC03, S2.04, S2.06] a stopped or outside-closed dwarf's open panel stays open with the composer disabled", async () => {
    for (const cause of ['stopped', 'closed-elsewhere'] as const) {
      useMines().stop()
      const host = installHost([page(3, [mineWire()], [dwarfWire(BORIN)])])
      const walks = recordWalks()
      await useMines().start()
      host.push([frame(4, 'dwarf.departed', { dwarfId: BORIN, mineId: ALPHA, cause })])
      expect(walks).toEqual([
        { kind: 'walk-out', dwarfId: BORIN, mineId: ALPHA, cause, panel: 'read-only' }
      ])
      // The dwarf the panel reads is still on the board, as a session that takes no more text.
      const [shown] = boardDwarfs()
      expect(shown?.id).toBe(BORIN)
      expect(sessionClosed(shown!, false)).toBe(true)
      forgetWalks()
    }
    // S2.05: a dwarf whose mine was removed closes its panel outright.
    useMines().stop()
    const host = installHost([page(3, [mineWire()], [dwarfWire(BORIN)])])
    const walks = recordWalks()
    await useMines().start()
    host.push([
      frame(4, 'dwarf.departed', { dwarfId: BORIN, mineId: ALPHA, cause: 'mine-removed' })
    ])
    expect(walks).toEqual([
      { kind: 'walk-out', dwarfId: BORIN, mineId: ALPHA, cause: 'mine-removed', panel: 'closed' }
    ])
  })

  it('[ADR-033] frames with seq at or below the snapshot seq are dropped and resync-required re-snapshots', async () => {
    const host: Host = installHost([
      () => {
        // Frames that arrive while the snapshot is being read are buffered (14 §4.3 rule 1).
        host.push([
          frame(4, 'dwarf.arrived', { dwarf: dwarfWire(DAIN), announce: false }),
          frame(5, 'dwarf.changed', { dwarf: dwarfWire(BORIN, { status: 'working' }) }),
          frame(6, 'dwarf.changed', { dwarf: dwarfWire(BORIN, { status: 'idle' }) })
        ])
        return page(5, [mineWire()], [dwarfWire(BORIN, { status: 'working' })])
      },
      page(20, [mineWire({ name: 'alpha-again' })], [dwarfWire(BORIN)])
    ])
    const walks = recordWalks()
    await useMines().start()
    await settle()
    // seq 4 and 5 are in the snapshot already; only seq 6 applies.
    expect(boardDwarfs().map((dwarf) => [dwarf.id, dwarf.status])).toEqual([[BORIN, 'waiting']])
    expect(walks).toEqual([])
    // A frame at or below the last applied seq is dropped too.
    host.push([frame(6, 'dwarf.arrived', { dwarf: dwarfWire(DAIN), announce: false })])
    expect(boardDwarfs().map((dwarf) => dwarf.id)).toEqual([BORIN])
    // resync-required: a fresh snapshot replaces the board whole.
    host.push([frame(7, 'resync-required', { reason: 'seq-not-in-ring' })])
    await settle()
    expect(host.requests).toHaveLength(2)
    expect(useMines().state.mines.map((mine) => mine.name)).toEqual(['alpha-again'])
  })

  /*
   * APPENDED for ISSUE-255. The walk-out keeps today's corridor route and speed (the pinned design's
   * ruling), so it can take seconds or a fraction of one: the board keeps a departed dwarf for as long
   * as its own sprite walks out and fades, said by the sprite itself (SceneDwarf), never for a flat
   * 720 ms. One no sprite walks (its mine is not open) still goes after WALK_OUT_MS. Under reduced
   * motion there is no walk, so it goes at once.
   */
  describe('the walk-out (ISSUE-255)', () => {
    afterEach(() => {
      Reflect.deleteProperty(window, 'matchMedia')
    })

    async function departed(): Promise<void> {
      const host = installHost([page(3, [mineWire()], [dwarfWire(BORIN), dwarfWire(DAIN)])])
      await useMines().start()
      host.push([frame(4, 'dwarf.departed', { dwarfId: BORIN, mineId: ALPHA, cause: 'stopped' })])
    }
    const leaving = () =>
      boardDwarfs()
        .filter((dwarf) => dwarf.status === 'leaving')
        .map((dwarf) => dwarf.id)

    it('[NFR-TIM-09] a long walk-out is not cut short: the dwarf stays on the board until its own walk-out ends', async () => {
      await departed()
      useMines().walkingOut(BORIN)
      // A climb from the ceiling gallery: far longer than 720 ms.
      vi.advanceTimersByTime(9_000)
      expect(leaving()).toEqual([BORIN])
      useMines().walkedOut(BORIN)
      expect(leaving()).toEqual([])
      expect(boardDwarfs().map((dwarf) => dwarf.id)).toEqual([DAIN])
    })

    it('[NFR-TIM-09] a short walk-out is not held: the dwarf goes when its walk-out ends', async () => {
      await departed()
      useMines().walkingOut(BORIN)
      vi.advanceTimersByTime(300)
      useMines().walkedOut(BORIN)
      expect(leaving()).toEqual([])
    })

    it('[NFR-TIM-09] a walk-out nobody reports ending still ends, however the sprite went', async () => {
      await departed()
      useMines().walkingOut(BORIN)
      vi.advanceTimersByTime(60_000)
      expect(leaving()).toEqual([])
    })

    it('[US-MINE-009.AC05, NFR-A11Y-10] under reduced motion a departed dwarf leaves the board at once, its walk-out still told', async () => {
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        value: () => ({ matches: true })
      })
      const walks = recordWalks()
      await departed()
      expect(boardDwarfs().map((dwarf) => dwarf.id)).toEqual([DAIN])
      expect(walks).toEqual([
        { kind: 'walk-out', dwarfId: BORIN, mineId: ALPHA, cause: 'stopped', panel: 'read-only' }
      ])
    })
  })

  /*
   * APPENDED for ISSUE-254: the Host's status reaches the scene as the Host said it. Today's board has
   * one `waiting` for asking, idle and asleep alike, so the Host's own word rides on the board dwarf
   * and the scene reads it first: a Host-idle dwarf is "Waiting", never drawn asleep.
   */
  it('[US-OBS-002.AC05, US-OBS-004.AC11, ADR-033] a Host-idle dwarf reads Waiting, not asleep, and every Host status is drawn as the Host said it', async () => {
    const CALLED = {
      idle: '01920000-0000-7000-8000-00000000d011',
      asleep: '01920000-0000-7000-8000-00000000d012',
      asking: '01920000-0000-7000-8000-00000000d013',
      working: '01920000-0000-7000-8000-00000000d014'
    } as const
    installHost([
      page(
        3,
        [mineWire()],
        (Object.keys(CALLED) as Array<keyof typeof CALLED>).map((status) =>
          dwarfWire(CALLED[status] as DwarfId, { status, needsYou: status === 'asking' })
        )
      )
    ])
    await useMines().start()
    await settle()
    const drawn = boardDwarfs().map((dwarf) => ({
      scene: sceneDwarfStatus(dwarf),
      tip: dwarfTip(dwarf).statusText
    }))
    expect(drawn).toEqual([
      { scene: 'idle', tip: 'Waiting' },
      { scene: 'asleep', tip: 'asleep' },
      { scene: 'asking', tip: 'needs you' },
      { scene: 'working', tip: 'working' }
    ])
  })

  /*
   * APPENDED for ISSUE-179 (read side, ISSUE-001 part C): "Stop dwarf…" reads its availability off the Host's
   * `DwarfWire.stopUnavailableReason` (14 §3.6; 14 §4.1 `dwarfs` consumer `useDwarfStopping`), never derived here.
   */
  it("[INV-31, ADR-033] a dwarf's stop availability is the Host's stopUnavailableReason, kept current by dwarf.changed", async () => {
    const host = installHost([
      page(3, [mineWire()], [dwarfWire(BORIN, { stopUnavailableReason: 'already-stopping' })])
    ])
    const { start, stopUnavailableReason } = useMines()
    await start()
    await settle()
    expect(stopUnavailableReason(BORIN)).toBe('already-stopping')
    host.push([frame(4, 'dwarf.changed', { dwarf: dwarfWire(BORIN) })])
    expect(stopUnavailableReason(BORIN)).toBeNull()
    host.push([
      frame(5, 'dwarf.changed', {
        dwarf: dwarfWire(BORIN, { stopInFlight: true, stopUnavailableReason: 'already-stopping' })
      })
    ])
    expect(stopUnavailableReason(BORIN)).toBe('already-stopping')
    // A dwarf the Host does not hold has no reason of its own: nothing is assumed about it.
    expect(stopUnavailableReason(DAIN)).toBeNull()
  })
})
