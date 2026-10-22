// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, shallowRef } from 'vue'
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
import { createFakeWindowApi } from '../../../contracts/ipc/testing/fakeWindowApi'
import { sessionClosed } from '../lib/delivery/actionBar'
import { useDwarfMessaging } from './useDwarfMessaging'
import { useMessageDock, type MessageDockOptions } from './useMessageDock'
import { useMines } from './useMines'

/*
 * The dock with more than one conversation on screen (a Valle package gap resolved in development, EPIC-20 task TVC):
 * Valle's Work front shows two chats side by side (07 machine 30; US-VALLE-008), each the Panel's own MessagePanel fed
 * by the window's one dock (ADR-033 item 5; BR-21). The dock keeps one open chat, the one its paging and launch hand-over
 * follow; the chats its host says are shown beside it (`shown`) draw their own dwarf and conversation, keep their sent
 * messages' bubbles, and keep their dwarf once it left, as the open chat does (#192). Mounted in a bare host component
 * against the generated fake `window.api` (ADR-033 item 7).
 */

type Api = Window['api']
type Dock = ReturnType<typeof useMessageDock>

const EPOCH = 'epoch-1'
const ALPHA = '01920000-0000-7000-8000-00000000a001' as MineId
const BORIN = '01920000-0000-7000-8000-00000000d001' as DwarfId
const DAIN = '01920000-0000-7000-8000-00000000d002' as DwarfId

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

const dwarfWire = (id: DwarfId, baseName: string): DwarfWire =>
  ({
    id,
    mineId: ALPHA,
    providerId: 'claude',
    baseName,
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
  }) as DwarfWire

const snapshot: IpcResult<SnapshotPage> = {
  ok: true,
  value: {
    snapshotId: 'snap-3',
    seq: 3,
    epoch: EPOCH,
    chunks: [
      { section: 'mines', data: [mine] },
      { section: 'dwarfs', data: [dwarfWire(BORIN, 'Borin'), dwarfWire(DAIN, 'Dain')] }
    ]
  }
}

const listeners = new Set<(frames: HostFrame[]) => void>()
const push = (frames: HostFrame[]): void => {
  for (const listener of listeners) listener(frames)
}
let wrapper: VueWrapper | null = null

function departed(dwarfId: DwarfId): HostFrame {
  const data: HostFrames['dwarf.departed'] = { dwarfId, mineId: ALPHA, cause: 'stopped' }
  return { type: 'evt', seq: 4, epoch: EPOCH, name: 'dwarf.departed', data } as HostFrame
}

/** The dock, mounted with `options`, the Host board read. */
async function mountDock(options: MessageDockOptions): Promise<Dock> {
  const api = createFakeWindowApi({
    getHostSnapshot: vi.fn(() => Promise.resolve(snapshot)) as unknown as Api['getHostSnapshot'],
    onHostEvent: vi.fn((follow: (frames: HostFrame[]) => void) => {
      listeners.add(follow)
      return () => {
        listeners.delete(follow)
      }
    }) as unknown as Api['onHostEvent']
  })
  Object.defineProperty(window, 'api', { configurable: true, writable: true, value: api })
  await useMines().start()
  let dock: Dock | null = null
  wrapper = mount(
    defineComponent({
      setup() {
        dock = useMessageDock(options)
        return () => h('div')
      }
    })
  )
  await flushPromises()
  return dock!
}

beforeEach(() => {
  vi.useFakeTimers()
  useMines().stop()
  useMines().clear()
  useDwarfMessaging().clearAll()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  useMines().stop()
  useMines().clear()
  useDwarfMessaging().clearAll()
  vi.runAllTimers()
  vi.useRealTimers()
})

describe('the dock with chats shown beside the open one (Valle, TVC)', () => {
  it("[US-VALLE-008.AC01] a chat shown in the second pane draws its own dwarf and its own conversation, the open chat's untouched", async () => {
    const dock = await mountDock({ shown: () => [DAIN] })
    dock.openMessage(ALPHA, BORIN)
    await flushPromises()

    const open = dock.conversationOf(BORIN)
    expect(open.dwarf?.id).toBe(BORIN)
    expect(open.feed).toBe(dock.drawnFeed.value)
    const beside = dock.conversationOf(DAIN)
    expect(beside.dwarf?.id).toBe(DAIN)
    expect(beside.dwarf?.name).toBe('Dain')
    expect(beside.feed).toBe(useDwarfMessaging().chatFeedOf(DAIN))
    expect(beside.routeGone).toBe(false)
    // The open chat is still the dock's one: its paging and hand-over follow Borin.
    expect(dock.openDwarfId.value).toBe(BORIN)
  })

  it('[US-VALLE-008.AC01, US-MSG-009.AC03] a message sent in one pane keeps its bubble when the other pane becomes the open chat', async () => {
    const shown = shallowRef<readonly string[]>([BORIN, DAIN])
    const dock = await mountDock({ shown: () => shown.value })
    dock.openMessage(ALPHA, BORIN)
    await flushPromises()
    const borin = dock.conversationOf(BORIN).dwarf!
    dock.sendText(borin, { text: 'Read the notes.', pressEnter: true })
    await flushPromises()
    expect(dock.sentEchoes[BORIN]?.map((echo) => echo.text)).toEqual(['Read the notes.'])

    // A press in the other pane: Dain's chat is the open one now, Borin's still on screen beside it.
    dock.openMessage(ALPHA, DAIN)
    await flushPromises()
    expect(dock.sentEchoes[BORIN]?.map((echo) => echo.text)).toEqual(['Read the notes.'])

    // Once Borin's chat leaves the screen, its bubble goes as the Panel's does on a switch.
    shown.value = [DAIN]
    await flushPromises()
    expect(dock.sentEchoes[BORIN]).toBeUndefined()
  })

  it('[US-VALLE-008.AC01] a message sent in the pane beside the open chat shows once, not twice, when its transcript takes it', async () => {
    const dock = await mountDock({ shown: () => [BORIN, DAIN] })
    dock.openMessage(ALPHA, BORIN)
    await flushPromises()
    dock.sendText(dock.conversationOf(DAIN).dwarf!, { text: 'Read the notes.', pressEnter: true })
    await flushPromises()
    expect(dock.sentEchoes[DAIN]?.map((echo) => echo.text)).toEqual(['Read the notes.'])

    const row = {
      id: '01890a5d-ac96-774b-a000-000000000001',
      dwarfId: DAIN,
      role: 'person',
      text: 'Read the notes.',
      attachments: [],
      providerTime: null,
      createdAt: Date.now() + 1_000
    }
    push([
      {
        type: 'evt',
        seq: 5,
        epoch: EPOCH,
        name: 'conversation.appended',
        data: { dwarfId: DAIN, messages: [row] }
      } as unknown as HostFrame
    ])
    await flushPromises()

    expect(dock.sentEchoes[DAIN] ?? []).toEqual([])
  })

  it('[S18.02, US-VALLE-007.AC07] a shown chat whose dwarf left keeps its last known dwarf, ended', async () => {
    const dock = await mountDock({ shown: () => [DAIN] })
    dock.openMessage(ALPHA, BORIN)
    await flushPromises()
    push([departed(DAIN)])
    await flushPromises()
    vi.runAllTimers()
    await flushPromises()

    const gone = dock.conversationOf(DAIN)
    expect(gone.dwarf?.id).toBe(DAIN)
    expect(sessionClosed(gone.dwarf!, gone.routeGone)).toBe(true)
  })
})
