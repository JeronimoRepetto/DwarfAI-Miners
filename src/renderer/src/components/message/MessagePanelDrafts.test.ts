// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
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
  SnapshotPage
} from '@dwarfai/contracts'
import { createFakeWindowApi } from '../../../../contracts/ipc/testing/fakeWindowApi'
import { useMessageDock } from '../../composables/useMessageDock'
import { useMines } from '../../composables/useMines'
import { useToasts } from '../../composables/useToasts'
import type { MessageEcho } from '../../lib/message/echo'
import { defaultDwarf } from '../../testing/factories'
import DwarfMessagePanel from './DwarfMessagePanel.vue'
import { publishBoard } from '../../testing/board'

/*
 * ISSUE-257 (EPIC-16): drafts per dwarf for the app run (US-MSG-009; NFR-PERS-06; decision log,
 * Drafts per dwarf), and Copy on a failed message (US-MSG-003.AC03, US-MSG-013.AC03). The real
 * dock (useMessageDock) holds the drafts and owns the clipboard call and its toast; the real
 * MessagePanel draws them, wired as App.vue wires it, keyed per dwarf so a switch remounts it. A
 * switch to the mine history or the Add panel takes the panel out of the slot the same way.
 * Mounted against the generated fake `window.api` (ADR-033 item 7).
 */

type Api = Window['api']
type Dock = ReturnType<typeof useMessageDock>

const EPOCH = 'epoch-1'
const ALPHA = '01920000-0000-7000-8000-00000000a001' as MineId
const BORIN = '01920000-0000-7000-8000-00000000d001' as DwarfId
const DORI = '01920000-0000-7000-8000-00000000d002' as DwarfId

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

function dwarfWire(id: DwarfId, baseName: string): DwarfWire {
  return {
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
  } as DwarfWire
}

const snapshot: IpcResult<SnapshotPage> = {
  ok: true,
  value: {
    snapshotId: 'snap-3',
    seq: 3,
    epoch: EPOCH,
    chunks: [
      { section: 'mines', data: [mine] },
      { section: 'dwarfs', data: [dwarfWire(BORIN, 'Borin'), dwarfWire(DORI, 'Dori')] }
    ]
  }
}

/** A one-step question, as a held session asks it (ISSUE-260's fixture). */
const ONE_STEP = {
  toolUseId: 'toolu_26',
  channel: 'held' as const,
  questions: [
    {
      question: 'Which database?',
      multiSelect: false,
      options: [{ label: 'Postgres' }, { label: 'SQLite' }]
    }
  ]
}

const listeners = new Set<(frames: HostFrame[]) => void>()
function push(frames: HostFrame[]): void {
  for (const listener of listeners) listener(frames)
}

function departed(dwarfId: DwarfId, cause: DepartureCause): HostFrame {
  const data: HostFrames['dwarf.departed'] = { dwarfId, mineId: ALPHA, cause }
  return { type: 'evt', seq: 4, epoch: EPOCH, name: 'dwarf.departed', data } as HostFrame
}

interface Slot {
  dock: Dock
  /** What else the dock's slot can show in the panel's place: the mine history. */
  history: { value: boolean }
  wrapper: VueWrapper
  /** The composer of the panel in the slot, if one is drawn. */
  well(): HTMLTextAreaElement | null
}

let mounted: VueWrapper | null = null

/** The dock mounted in a host that draws its MessagePanel as App.vue does, with Borin open. */
async function openDock(
  overrides: Partial<Api> = {},
  echoes?: readonly MessageEcho[]
): Promise<Slot> {
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
    ) as unknown as Api['getDwarfFeed'],
    ...overrides
  })
  Object.defineProperty(window, 'api', { configurable: true, writable: true, value: api })
  await useMines().start()
  // The Host board with a delivery route (`textDelivery`) on each dwarf, written as one publish of the board
  // (testing/board.ts; AMENDED for ISSUE-242, was: A-P2 folding it on through useMines `legacyAsks`, deleted at cut 5):
  // without one the composer is rightly asleep.
  publishBoard({
    mines: useMines().state.mines.map((mine) => ({
      ...mine,
      dwarfs: mine.dwarfs.map((dwarf) => ({ ...dwarf, textDelivery: 'terminal' as const }))
    }))
  })
  let dock: Dock | null = null
  const history = ref(false)
  mounted = mount(
    defineComponent({
      setup() {
        const own = useMessageDock()
        dock = own
        return () => {
          const dwarf = own.selectedDwarf.value
          if (history.value || own.surface.value.surface !== 'message' || dwarf === undefined) {
            return h('div', { class: 'slot' })
          }
          return h('div', { class: 'slot' }, [
            h(DwarfMessagePanel, {
              key: dwarf.id,
              dwarf,
              routeGone: own.selectedRouteGone.value,
              feed: own.drawnFeed.value,
              draft: own.drafts.value[dwarf.id],
              echoes: echoes ?? own.sentEchoes[dwarf.id],
              onDraft: (text: string) => own.setDraft(dwarf.id, text),
              onSend: (payload: Parameters<Dock['sendText']>[1]) => own.sendText(dwarf, payload),
              onCopy: (text: string) => own.copyMessage(text)
            })
          ])
        }
      }
    })
  )
  dock!.openMessage(ALPHA, BORIN)
  await flushPromises()
  const wrapper = mounted
  return {
    dock: dock!,
    history,
    wrapper,
    well: () => {
      const found = wrapper.find('.dm-composer textarea')
      return found.exists() ? (found.element as HTMLTextAreaElement) : null
    }
  }
}

async function type(slot: Slot, text: string): Promise<void> {
  await slot.wrapper.find('.dm-composer textarea').setValue(text)
}

async function settle(): Promise<void> {
  await flushPromises()
}

beforeEach(() => {
  vi.useFakeTimers()
  useMines().stop()
  useMines().clear()
})

afterEach(() => {
  mounted?.unmount()
  mounted = null
  useMines().stop()
  useMines().clear()
  vi.runAllTimers()
  vi.useRealTimers()
})

describe('MessagePanel drafts per dwarf (ISSUE-257)', () => {
  it("[US-MSG-009.AC01, US-MSG-009.AC03, NFR-PERS-06] each dwarf's draft comes back after switching to another dwarf, the history or the Add panel, and never shows another dwarf's text", async () => {
    const slot = await openDock()
    await type(slot, 'Borin, check the seam.')

    // Another dwarf: its own, empty composer; then its own draft.
    slot.dock.openMessage(ALPHA, DORI)
    await settle()
    expect(slot.well()!.value).toBe('')
    await type(slot, 'Dori, sort the ledger.')

    // Back to Borin: his words, never Dori's.
    slot.dock.openMessage(ALPHA, BORIN)
    await settle()
    expect(slot.well()!.value).toBe('Borin, check the seam.')

    // The mine history in the panel's place, and back.
    slot.history.value = true
    await settle()
    expect(slot.wrapper.find('.dm-composer').exists()).toBe(false)
    slot.history.value = false
    await settle()
    expect(slot.well()!.value).toBe('Borin, check the seam.')

    // The Add panel in its place, and back to Dori.
    slot.dock.openLaunch(ALPHA)
    await settle()
    expect(slot.wrapper.find('.dm-composer').exists()).toBe(false)
    slot.dock.openMessage(ALPHA, DORI)
    await settle()
    expect(slot.well()!.value).toBe('Dori, sort the ledger.')
    // Send is awake on a draft put back (screens/message.md, Drafts).
    expect(slot.wrapper.find('.dm-composer__send').attributes('disabled')).toBeUndefined()
  })

  it("[US-MSG-009.AC02, US-MSG-001.AC08, US-MSG-009.AC04] sending a message or submitting a card clears that dwarf's draft", async () => {
    const sendDwarfText = vi.fn(() => Promise.resolve({ delivered: true, via: 'terminal' }))
    const slot = await openDock({ sendDwarfText: sendDwarfText as unknown as Api['sendDwarfText'] })
    await type(slot, 'Run only the unit suite.')
    slot.dock.openMessage(ALPHA, DORI)
    await settle()
    await type(slot, 'Dori keeps hers.')
    slot.dock.openMessage(ALPHA, BORIN)
    await settle()
    expect(slot.well()!.value).toBe('Run only the unit suite.')

    await slot.wrapper.find('.dm-composer textarea').trigger('keydown', { key: 'Enter' })
    await settle()
    expect(sendDwarfText).toHaveBeenCalledTimes(1)
    expect(slot.well()!.value).toBe('')
    expect(slot.dock.drafts.value[BORIN]).toBeUndefined()
    // It does not return after a switch, and the other dwarf's draft is untouched.
    slot.dock.openMessage(ALPHA, DORI)
    await settle()
    expect(slot.well()!.value).toBe('Dori keeps hers.')
    slot.dock.openMessage(ALPHA, BORIN)
    await settle()
    expect(slot.well()!.value).toBe('')

    // A card's submit is a send too (US-MSG-009.AC04): Dori asks, the card takes the composer's
    // place, and its Submit empties the draft the dock keeps for her (ISSUE-260; #1353).
    expect(slot.dock.drafts.value[DORI]).toBe('Dori keeps hers.')
    const asking = mount(DwarfMessagePanel, {
      props: {
        dwarf: defaultDwarf({ id: DORI, textDelivery: 'terminal', pendingQuestion: ONE_STEP }),
        draft: slot.dock.drafts.value[DORI],
        onDraft: (text: string) => slot.dock.setDraft(DORI, text)
      }
    })
    await asking.find('.dm-qcard .dm-qopt').trigger('click')
    await asking.find('.dm-qcard__submit').trigger('click')
    expect(asking.emitted('answer')).toEqual([['Postgres']])
    expect(slot.dock.drafts.value[DORI]).toBeUndefined()
    asking.unmount()
  })

  it('[US-MSG-009.AC05] when the dwarf dies its draft is dropped', async () => {
    for (const cause of ['stopped', 'closed-elsewhere'] as const) {
      const slot = await openDock()
      await type(slot, 'Half a thought.')
      expect(slot.dock.drafts.value[BORIN]).toBe('Half a thought.')

      push([departed(BORIN, cause)])
      await settle()
      // Past the walk-out, so the sprite is dropped too (S2.17); the panel's clock ticks on.
      vi.advanceTimersByTime(10_000)
      await settle()

      // Nothing kept to restore: not in the dock, not in the well that stays open on the ended
      // session, and not after a switch away and back.
      expect(slot.dock.drafts.value[BORIN]).toBeUndefined()
      expect(slot.well()?.value ?? '').toBe('')
      slot.dock.openMessage(ALPHA, DORI)
      await settle()
      slot.dock.openMessage(ALPHA, BORIN)
      await settle()
      expect(slot.dock.drafts.value[BORIN]).toBeUndefined()
      expect(slot.well()?.value ?? '').toBe('')

      mounted?.unmount()
      mounted = null
      useMines().stop()
      useMines().clear()
    }
  })
})

describe('MessagePanel Copy on a failed message (ISSUE-257)', () => {
  const FAILED: MessageEcho = {
    id: 'e2',
    text: 'second\nline',
    sentAt: 0,
    state: { phase: 'failed', error: 'nope' }
  }

  it('[US-MSG-003.AC03, US-MSG-013.AC03] Copy on a failed message copies its text, shows Message copied and leaves the bubble failed', async () => {
    for (const ended of [false, true]) {
      const copyText = vi.fn(() => Promise.resolve({ copied: true }))
      const slot = await openDock({ copyText: copyText as unknown as Api['copyText'] }, [FAILED])
      if (ended) {
        // The Copy-alone state: the session behind the message has closed.
        push([departed(BORIN, 'stopped')])
        await settle()
      }
      const group = slot.wrapper.find('.dm-bubble__actions')
      const copy = group.findAll('.dm-btn').find((button) => button.text() === 'Copy')!
      expect(group.findAll('.dm-btn').map((b) => b.text())).toEqual(
        ended ? ['Copy'] : ['Retry', 'Copy']
      )
      await copy.trigger('click')
      await settle()

      expect(copyText).toHaveBeenCalledWith('second\nline')
      expect(useToasts().toasts.value.map((toast) => toast.text)).toContain('Message copied')
      // The bubble is still the failed one, with its way out.
      const bubble = slot.wrapper.findAll('.dm-bubble--user').at(-1)!
      expect(bubble.find('.dm-bubble__mark').attributes('data-mark')).toBe('failed')
      expect(bubble.find('.dm-bubble__actions').exists()).toBe(true)

      mounted?.unmount()
      mounted = null
      useMines().stop()
      useMines().clear()
      vi.runAllTimers()
    }
  })
})
