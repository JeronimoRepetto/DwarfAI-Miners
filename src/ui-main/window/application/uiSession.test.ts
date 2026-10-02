// layer: L2
import { describe, expect, it } from 'vitest'
import type {
  AskId,
  ChatViewState,
  DwarfId,
  EvtFrame,
  MessageId,
  MineId,
  UiSessionPatch,
  UiSessionSnapshot
} from '@dwarfai/contracts'
import { InMemorySessionStore } from '../adapters/InMemorySessionStore'
import type { HostEvent } from '../ports/hostClient'
import { RecordingHostClient } from '../ports/fakes/RecordingHostClient'
import { createUiSession, UI_SESSION_CHANGED_PUSH, type UiSessionWindow } from './uiSession'

const BORIN = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a01' as DwarfId
const DORI = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a02' as DwarfId
const MINE_A = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1b01' as MineId
const MINE_B = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1b02' as MineId
const ASK = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1c01' as AskId
const ANCHORED: ChatViewState = {
  scrollAnchor: { messageId: '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1d01' as MessageId, offsetPx: 40 },
  selection: { start: 2, end: 2, direction: 'none' }
}
const EMPTY: UiSessionSnapshot = {
  drafts: {},
  chatViews: {},
  askPicks: {},
  openChat: {},
  currentMine: {},
  valle: {}
}

/** A mode window that records the pushes it receives. */
function windowOf(webContentsId: number, mode: UiSessionWindow['mode']) {
  const sent: Array<[string, unknown]> = []
  const window: UiSessionWindow = {
    webContentsId,
    mode,
    send: (push, payload) => void sent.push([push, payload])
  }
  return { window, sent }
}

function world() {
  const host = new RecordingHostClient()
  const panel = windowOf(1, 'panel')
  const veta = windowOf(2, 'veta')
  const valle = windowOf(3, 'valle')
  const session = createUiSession({
    store: new InMemorySessionStore(),
    windows: () => [panel.window, veta.window, valle.window],
    host
  })
  const fromPanel = { webContentsId: 1, mode: 'panel' } as const
  const fromValle = { webContentsId: 3, mode: 'valle' } as const
  return { host, panel, veta, valle, session, fromPanel, fromValle }
}

/** The `dwarf.departed` frame of 14 §3.5 (its catalog entry lands with its publisher, later: ISSUE-082). */
function departed(dwarfId: DwarfId): HostEvent {
  const frame = {
    type: 'evt',
    seq: 7,
    epoch: 'boot-1',
    name: 'dwarf.departed',
    data: { dwarfId, mineId: MINE_A, cause: 'stopped' }
  }
  return { kind: 'frame', frame: frame as unknown as EvtFrame }
}

/** One patch of every kind (14 §3.9 `UiSessionPatch`). */
const EVERY_KIND: UiSessionPatch[] = [
  { kind: 'draft', dwarfId: BORIN, text: 'half a thought' },
  { kind: 'chat-view', dwarfId: BORIN, view: ANCHORED },
  { kind: 'ask-picks', askId: ASK, picks: [{ step: 0, option: 'Yes' }] },
  { kind: 'open-chat', host: 'panel', dwarfId: BORIN },
  { kind: 'current-mine', host: 'panel', mineId: MINE_A },
  { kind: 'valle', patch: { mosaicScrollLeft: 120, historyOpen: true } },
  { kind: 'veta-risen-chat', dwarfId: BORIN }
]

describe('the UI-main session store (ADR-024 items 1, 3; 14 §3.9)', () => {
  it('[INV-113, NFR-PERS-06] a draft patch from the Panel is visible to getUiSession and pushed to the other windows with its origin', () => {
    const { session, panel, veta, valle, fromPanel } = world()

    session.patch({ kind: 'draft', dwarfId: BORIN, text: 'half a thought' }, fromPanel)

    expect(session.get().drafts).toEqual({ [BORIN]: 'half a thought' })
    const change = {
      kind: 'draft',
      dwarfId: BORIN,
      text: 'half a thought',
      origin: 'panel'
    }
    expect(veta.sent).toEqual([[UI_SESSION_CHANGED_PUSH, change]])
    expect(valle.sent).toEqual([[UI_SESSION_CHANGED_PUSH, change]])
    // The window the patch came from already holds it.
    expect(panel.sent).toEqual([])
  })

  it("[INV-34, S2.04] a dwarf.departed frame drops that dwarf's draft, chat view and open-chat entries and emits the patches", () => {
    const { host, session, panel, veta, valle, fromPanel, fromValle } = world()
    session.patch({ kind: 'draft', dwarfId: BORIN, text: 'half a thought' }, fromPanel)
    session.patch({ kind: 'chat-view', dwarfId: BORIN, view: ANCHORED }, fromPanel)
    session.patch({ kind: 'open-chat', host: 'panel', dwarfId: BORIN }, fromPanel)
    session.patch({ kind: 'open-chat', host: 'veta', dwarfId: BORIN }, fromPanel)
    session.patch({ kind: 'open-chat', host: 'valle', dwarfId: DORI }, fromValle)
    session.patch({ kind: 'draft', dwarfId: DORI, text: 'keep me' }, fromValle)
    session.patch(
      {
        kind: 'valle',
        patch: {
          talkedTo: { [MINE_A]: BORIN, [MINE_B]: DORI },
          focusedPin: BORIN,
          secondPaneDwarfId: BORIN,
          mosaicScrollLeft: 80
        }
      },
      fromValle
    )
    for (const window of [panel, veta, valle]) window.sent.length = 0

    host.deliver(departed(BORIN))

    expect(session.get()).toEqual({
      ...EMPTY,
      drafts: { [DORI]: 'keep me' },
      openChat: { panel: null, veta: null, valle: DORI },
      valle: {
        talkedTo: { [MINE_B]: DORI },
        focusedPin: null,
        secondPaneDwarfId: null,
        mosaicScrollLeft: 80
      }
    })
    // UI main emits the patches itself, so every window hears them; no window is their origin.
    const pushed = [
      { kind: 'draft', dwarfId: BORIN, text: '', origin: 'hidden' },
      { kind: 'chat-view', dwarfId: BORIN, view: { scrollAnchor: 'bottom' }, origin: 'hidden' },
      { kind: 'open-chat', host: 'panel', dwarfId: null, origin: 'hidden' },
      { kind: 'open-chat', host: 'veta', dwarfId: null, origin: 'hidden' },
      {
        kind: 'valle',
        patch: { talkedTo: { [MINE_B]: DORI }, focusedPin: null, secondPaneDwarfId: null },
        origin: 'hidden'
      }
    ].map((change) => [UI_SESSION_CHANGED_PUSH, change])
    for (const window of [panel, veta, valle]) expect(window.sent).toEqual(pushed)

    // A departure of a dwarf the store holds nothing for changes nothing and pushes nothing.
    for (const window of [panel, veta, valle]) window.sent.length = 0
    host.deliver(departed(BORIN))
    for (const window of [panel, veta, valle]) expect(window.sent).toEqual([])
  })

  it('[S10.15, NFR-PERS-06] entering tray-only clears the whole session store', () => {
    const { session, fromPanel } = world()
    for (const patch of EVERY_KIND) session.patch(patch, fromPanel)
    session.patch({ kind: 'draft', dwarfId: DORI, text: 'another' }, fromPanel)
    session.patch({ kind: 'valle', patch: { talkedTo: { [MINE_A]: DORI } } }, fromPanel)
    expect(session.get()).not.toEqual(EMPTY)

    session.clear()

    expect(session.get()).toEqual(EMPTY)
  })

  it('[INV-115] the current mine is kept per host and never as one global field', () => {
    const { session, fromPanel, fromValle } = world()

    session.patch({ kind: 'current-mine', host: 'panel', mineId: MINE_A }, fromPanel)
    session.patch({ kind: 'current-mine', host: 'valle', mineId: MINE_B }, fromValle)
    expect(session.get().currentMine).toEqual({ panel: MINE_A, valle: MINE_B })

    session.patch({ kind: 'current-mine', host: 'panel', mineId: null }, fromPanel)
    expect(session.get().currentMine).toEqual({ panel: null, valle: MINE_B })
  })

  it('[INV-113] no patch kind is ever forwarded to the Host', () => {
    const { host, session, fromPanel } = world()

    for (const patch of EVERY_KIND) session.patch(patch, fromPanel)
    session.get()
    host.deliver(departed(BORIN))
    session.clear()

    // The one thing the store asks of the client is to hear the Host's frames (dwarf.departed).
    expect(host.calls).toEqual([{ member: 'subscribe' }])
  })

  it('[ADR-003] the store hears the Host only while it holds something, so tray-only keeps no subscription open', () => {
    const { host, session, fromPanel } = world()
    // An empty store has nothing a departure could drop: it holds no subscription (and so no `ui` connection).
    expect(host.subscribers).toBe(0)

    session.patch({ kind: 'draft', dwarfId: BORIN, text: 'half a thought' }, fromPanel)
    session.patch({ kind: 'draft', dwarfId: DORI, text: 'another' }, fromPanel)
    expect(host.subscribers).toBe(1)

    session.clear()
    expect(host.subscribers).toBe(0)

    // The next window's first patch listens again.
    session.patch({ kind: 'open-chat', host: 'panel', dwarfId: DORI }, fromPanel)
    expect(host.subscribers).toBe(1)
    session.dispose()
    expect(host.subscribers).toBe(0)
  })
})
