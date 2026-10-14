// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import type {
  DepartureCause,
  DwarfId,
  DwarfWire,
  FolderPath,
  HostFrame,
  HostFrames,
  IpcResult,
  MessageId,
  MessageView,
  MineId,
  MineWire,
  SnapshotPage,
  SnapshotParams
} from '@dwarfai/contracts'
import { createFakeWindowApi } from '../../../contracts/ipc/testing/fakeWindowApi'
import { sessionClosed } from '../lib/delivery/actionBar'
import { conversationOf, READING_NOTE } from '../lib/message/conversation'
import { useDwarfMessaging } from './useDwarfMessaging'
import { useHostConnection } from './useHostConnection'
import { useMessageDock } from './useMessageDock'
import { useMines } from './useMines'

/** A bare host component that mounts the dock and hands it out. */
function dockHost(take: (dock: ReturnType<typeof useMessageDock>) => void) {
  return defineComponent({
    setup() {
      take(useMessageDock())
      return () => h('div')
    }
  })
}

/*
 * The MessagePanel when its dwarf's process closes (ISSUE-092; 07 S2.04…S2.06; US-OBS-005.AC03): the dock follows
 * the board's walk-outs, which only a Host `dwarf.departed` frame emits (14 §4.3 rule 6). A stopped or outside-closed
 * dwarf's open panel stays open, showing the conversation with the composer disabled; a dwarf whose mine was
 * removed closes its panel outright. Mounted in a bare host component against the generated fake `window.api`
 * (ADR-033 item 7).
 */
describe('useMessageDock on a departure', () => {
  type Api = Window['api']
  type Dock = ReturnType<typeof useMessageDock>

  const EPOCH = 'epoch-1'
  const ALPHA = '01920000-0000-7000-8000-00000000a001' as MineId
  const BORIN = '01920000-0000-7000-8000-00000000d001' as DwarfId

  const mine: MineWire = {
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

  // AMENDED for ISSUE-123 (was: one listener, the board's): the dock follows the Host's chats too from mount, so A-N02
  // has two listeners and a frame reaches both.
  const listeners = new Set<(frames: HostFrame[]) => void>()
  const push = (frames: HostFrame[]): void => {
    for (const listener of listeners) listener(frames)
  }
  let wrapper: VueWrapper | null = null

  function departed(cause: DepartureCause): HostFrame {
    const data: HostFrames['dwarf.departed'] = { dwarfId: BORIN, mineId: ALPHA, cause }
    return { type: 'evt', seq: 4, epoch: EPOCH, name: 'dwarf.departed', data } as HostFrame
  }

  /** The dock, mounted, with the Host board read and Borin's chat open. */
  async function openOnBorin(): Promise<Dock> {
    const api = createFakeWindowApi({
      getHostSnapshot: vi.fn(() => Promise.resolve(snapshot)) as unknown as Api['getHostSnapshot'],
      onHostEvent: vi.fn((follow: (frames: HostFrame[]) => void) => {
        listeners.add(follow)
        return () => {
          listeners.delete(follow)
        }
      }) as unknown as Api['onHostEvent'],
      getDwarfFeed: vi.fn(() =>
        Promise.resolve({ readable: true, messages: [] })
      ) as unknown as Api['getDwarfFeed']
    })
    Object.defineProperty(window, 'api', { configurable: true, value: api })
    await useMines().start()
    let dock: Dock | null = null
    wrapper = mount(
      dockHost((mounted) => {
        dock = mounted
      })
    )
    dock!.openMessage(ALPHA, BORIN)
    await flushPromises()
    return dock!
  }

  beforeEach(() => {
    vi.useFakeTimers()
    useMines().stop()
    useMines().clear()
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    useMines().stop()
    useMines().clear()
    vi.runAllTimers()
    vi.useRealTimers()
  })

  it("[US-OBS-005.AC03, S2.04, S2.06] a stopped or outside-closed dwarf's open panel stays open with the composer disabled", async () => {
    for (const cause of ['stopped', 'closed-elsewhere'] as const) {
      const dock = await openOnBorin()
      expect(dock.selectedDwarf.value?.id).toBe(BORIN)
      push([departed(cause)])
      await flushPromises()
      // While it walks out, and after its sprite is dropped (S2.17), the panel keeps showing it.
      vi.runAllTimers()
      await flushPromises()
      expect(dock.surface.value).toEqual({ surface: 'message', mineId: ALPHA, dwarfId: BORIN })
      expect(dock.selectedDwarf.value?.id).toBe(BORIN)
      expect(sessionClosed(dock.selectedDwarf.value!, dock.selectedRouteGone.value)).toBe(true)
      wrapper?.unmount()
      wrapper = null
      useMines().stop()
    }
  })

  it('[S2.05] a dwarf whose mine was removed closes its open panel', async () => {
    const dock = await openOnBorin()
    push([departed('mine-removed')])
    await flushPromises()
    expect(dock.surface.value).toEqual({ surface: 'none', mineId: '', dwarfId: '' })
  })
})

/*
 * The MessagePanel of a window that mounted before the Host attached (owner's log: the Host spawn took 1157 ms). Every
 * A-N01 read before `hello.ok` is refused, so the dock's one `startChat` on mount fails; the chat must be read again
 * once A-N04 reports `connected`, or the panel says "Reading this session's latest activity…" for the window's life.
 * Mounted in a bare host component against the generated fake `window.api` (ADR-033 item 7).
 */
describe('useMessageDock when the window opened before the Host attached', () => {
  type Api = Window['api']
  type Dock = ReturnType<typeof useMessageDock>

  const EPOCH = 'epoch-1'
  const ALPHA = '01920000-0000-7000-8000-00000000a001' as MineId
  const BORIN = '01920000-0000-7000-8000-00000000d001' as DwarfId

  const mine = {
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
    owned: false,
    arrivedAt: 1
  } as DwarfWire

  const line: MessageView = {
    id: '01920000-0000-7000-8000-00000000e001' as MessageId,
    dwarfId: BORIN,
    role: 'dwarf',
    text: 'the tests pass',
    attachments: [],
    providerTime: null,
    createdAt: 1_791_277_200_000
  }

  function page(params: SnapshotParams): IpcResult<SnapshotPage> {
    const sections = ('sections' in params ? params.sections : undefined) ?? []
    const chunks: SnapshotPage['chunks'] = []
    if (sections.includes('mines')) chunks.push({ section: 'mines', data: [mine] })
    if (sections.includes('dwarfs')) chunks.push({ section: 'dwarfs', data: [borin] })
    if (sections.includes('tails')) {
      chunks.push({
        section: 'tails',
        data: [{ dwarfId: BORIN, messages: [line], reachedStart: true }]
      })
    }
    return { ok: true, value: { snapshotId: 'snap-3', seq: 3, epoch: EPOCH, chunks } }
  }

  /** HostClient's answer to a call made before the first `hello.ok`. */
  const BEFORE_HELLO: IpcResult<SnapshotPage> = {
    ok: false,
    error: {
      code: 'NOT_SUPPORTED',
      message: 'the Host did not advertise this method',
      retryable: false
    }
  }

  let attached = false
  let connection: ((view: unknown) => void) | null = null
  let wrapper: VueWrapper | null = null

  function install(): void {
    const api = createFakeWindowApi({
      getHostSnapshot: vi.fn((params: SnapshotParams) =>
        Promise.resolve(attached ? page(params) : BEFORE_HELLO)
      ) as unknown as Api['getHostSnapshot'],
      onHostEvent: vi.fn(() => () => {}) as unknown as Api['onHostEvent'],
      getHostConnection: vi.fn(() =>
        Promise.resolve({ state: 'connecting' })
      ) as unknown as Api['getHostConnection'],
      onHostConnection: vi.fn((follow: (view: unknown) => void) => {
        connection = follow
        return () => {
          connection = null
        }
      }) as unknown as Api['onHostConnection']
    })
    Object.defineProperty(window, 'api', { configurable: true, value: api })
  }

  beforeEach(() => {
    vi.useFakeTimers()
    attached = false
    useMines().stop()
    useMines().clear()
    useDwarfMessaging().stopChat()
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    useMines().stop()
    useMines().clear()
    useDwarfMessaging().stopChat()
    useHostConnection().stop()
    vi.runAllTimers()
    vi.useRealTimers()
  })

  it('[ADR-033, S12.B01] a chat read before the Host attached is read again once A-N04 reports connected, and the panel leaves its reading note', async () => {
    install()
    // The shell follows A-N04 from its own mount (App.vue); the window opens while the Host is still being spawned.
    await useHostConnection().start()
    await useMines().start()
    let dock: Dock | null = null
    wrapper = mount(
      dockHost((mounted) => {
        dock = mounted
      })
    )
    await flushPromises()
    expect(useDwarfMessaging().chatFeedOf(BORIN)).toBeUndefined()

    attached = true
    connection!({ state: 'connected', capabilities: [] })
    await flushPromises()
    dock!.openMessage(ALPHA, BORIN)
    await flushPromises()

    expect(
      useDwarfMessaging()
        .chatFeedOf(BORIN)
        ?.messages.map((m) => m.text)
    ).toEqual(['the tests pass'])
    expect(dock!.selectedDwarf.value?.id).toBe(BORIN)
    const drawn = conversationOf(dock!.selectedDwarf.value!, dock!.drawnFeed.value)
    expect(drawn.note).not.toBe(READING_NOTE)
    expect(drawn.messages).toHaveLength(1)
  })
})
