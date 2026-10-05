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
import { defaultDwarf, defaultMaterials, defaultMine } from '../testing/factories'
import { useMines, type BoardWalk } from './useMines'
import { useToasts } from './useToasts'

/*
 * WHO IS NEW ON THE BOARD (#156).
 *
 * The mine's interior walks an arriving dwarf in from a spawn point, and it used
 * to decide who had arrived from its own first snapshot. That cannot see the one
 * case the acceptance run found: a mine nobody is working is not on the board at
 * all, so its interior is not mounted — launch the first agent and the scene
 * mounts with that agent already in it, which its own first snapshot reads as
 * "was already at work before anybody looked". The maintainer's first foreman
 * materialised on the spot; his second walked, because by then the interior had
 * been open long enough to see the mine empty.
 *
 * The panel has been polling the whole time and does know. This is that fact,
 * held where every consumer can read it: the dwarfs on this snapshot that were
 * not on the one before it.
 */
describe('useMines arrivals', () => {
  const crew = (...ids: string[]) => ids.map((id) => defaultDwarf({ id }))

  it('reports nobody as arriving on the first snapshot it ever sees', () => {
    // Everything running when the panel starts was already running. Calling
    // that an arrival would parade the whole valley across its interiors.
    const { state, setMines, clear } = useMines()
    clear()
    setMines({ mines: [defaultMine({ dwarfs: crew('a', 'b') })], tokensObserved: 0 })
    expect([...state.arrived]).toEqual([])
  })

  it('reports the dwarfs that were not on the snapshot before', () => {
    const { state, setMines, clear } = useMines()
    clear()
    setMines({ mines: [defaultMine({ dwarfs: crew('a') })], tokensObserved: 0 })
    setMines({ mines: [defaultMine({ dwarfs: crew('a', 'b') })], tokensObserved: 0 })
    expect([...state.arrived]).toEqual(['b'])
  })

  it('reports an arrival into a mine that had nobody in it', () => {
    // The reproduction: the mine is not on the board at all until a session
    // starts in it, so the arrival brings the mine with it.
    const { state, setMines, clear } = useMines()
    clear()
    setMines({ mines: [], tokensObserved: 0 })
    setMines({ mines: [defaultMine({ dwarfs: crew('a') })], tokensObserved: 0 })
    expect([...state.arrived]).toEqual(['a'])
  })

  it('stops calling a dwarf new once it has been on a snapshot', () => {
    const { state, setMines, clear } = useMines()
    clear()
    setMines({ mines: [], tokensObserved: 0 })
    setMines({ mines: [defaultMine({ dwarfs: crew('a') })], tokensObserved: 0 })
    setMines({ mines: [defaultMine({ dwarfs: crew('a') })], tokensObserved: 0 })
    expect([...state.arrived]).toEqual([])
  })

  it('forgets who was there when the board is cleared', () => {
    // A cleared board is a panel that has stopped looking; what it sees next is
    // a first snapshot again, not a valley of arrivals.
    const { state, setMines, clear } = useMines()
    setMines({ mines: [defaultMine({ dwarfs: crew('a') })], tokensObserved: 0 })
    clear()
    setMines({ mines: [defaultMine({ dwarfs: crew('a', 'b') })], tokensObserved: 0 })
    expect([...state.arrived]).toEqual([])
  })
})

describe('useMines', () => {
  it('stores the mines list and vault total from a snapshot', () => {
    const { state, setMines } = useMines()
    const mine = defaultMine({ tokensObserved: 500 })
    setMines({ mines: [mine], tokensObserved: 500 })
    expect(state.mines).toEqual([mine])
    expect(state.tokensObserved).toBe(500)
  })

  it('clears both the mines list and the vault total', () => {
    const { state, setMines, clear } = useMines()
    setMines({ mines: [defaultMine()], tokensObserved: 42 })
    clear()
    expect(state.mines).toEqual([])
    expect(state.tokensObserved).toBe(0)
  })
})

/*
 * The global vault (see #22) travels on the same snapshot. It is deliberately
 * NOT the sum of the mines in the list: main sums it over the entire persisted
 * ledger, so it includes projects with no crew today — which is the only place
 * backfilled coal can appear.
 */
describe('useMines global vault', () => {
  it('stores the whole-ledger breakdown the snapshot carries', () => {
    const { state, setMines } = useMines()
    const materials = defaultMaterials({ coal: 500_000 })
    setMines({ mines: [], tokensObserved: 0, materials })
    expect(state.materials).toEqual(materials)
  })

  it('carries an absent breakdown through as absent rather than inventing one', () => {
    const { state, setMines } = useMines()
    setMines({ mines: [], tokensObserved: 0, materials: defaultMaterials({ gold: 100_000 }) })
    setMines({ mines: [], tokensObserved: 0 })
    expect(state.materials).toBeUndefined()
  })

  it('clears the vault breakdown along with the rest', () => {
    const { state, setMines, clear } = useMines()
    setMines({ mines: [], tokensObserved: 42, materials: defaultMaterials({ bronze: 20_000 }) })
    clear()
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
    Object.defineProperty(window, 'api', { configurable: true, value: api })
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

  it('[ADR-033] while the Host read path is unrouted the board stays on the feed of today', async () => {
    // Hidden until built (21 §1 item 8): until the cut-1 switch (ISSUE-123) routes A-N01 the router refuses it, and
    // today's A-12/A-P2 feed stays the board's one writer.
    installHost([{ ok: false, error: { code: 'INTERNAL', message: 'no route' } } as SnapshotAnswer])
    await useMines().start()
    useMines().setMines({ mines: [defaultMine({ name: 'today' })], tokensObserved: 7 })
    expect(useMines().state.mines.map((mine) => mine.name)).toEqual(['today'])
    expect(useMines().state.tokensObserved).toBe(7)
  })

  it('[ADR-033] once the Host snapshot is read, the feed of today no longer writes the board', async () => {
    installHost([page(3, [mineWire()], [dwarfWire(BORIN)])])
    await useMines().start()
    useMines().setMines({ mines: [], tokensObserved: 0 })
    expect(useMines().state.mines.map((mine) => mine.name)).toEqual(['alpha'])
    expect(
      useMines()
        .hostDwarfs()
        .map((dwarf) => dwarf.id)
    ).toEqual([BORIN])
  })
})
