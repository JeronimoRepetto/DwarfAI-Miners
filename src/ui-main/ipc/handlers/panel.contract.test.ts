// layer: L6
import { describe, expect, it } from 'vitest'
import { CHANNELS, type ChannelKey } from '@dwarfai/contracts'
import {
  createPanelWindow,
  PANEL_VISIBILITY_PUSH,
  type PanelWindowSurface
} from '../../window/application/panelWindow'
import { FakeScreenAreaProvider } from '../../window/ports/fakes/FakeScreenAreaProvider'
import { FakeWindowFactory } from '../../window/ports/fakes/FakeWindowFactory'
import {
  createInMemoryUiPreferenceStorage,
  InMemoryUiPreferenceStore
} from '../../window/ports/fakes/InMemoryUiPreferenceStore'
import type { Rect } from '../../window/ports/windowFactory'
import type { ChannelRoute } from '../channelRoute'
import { createRouter, type RouteTarget } from '../router'
// AMENDED for ISSUE-056 (was: `ROUTES`, which was this table until the cut-0 switch): the suite is written against
// today's table, every row `legacy` with today's shape, kept as `PRE_CUT_0_ROUTES`.
import { PRE_CUT_0_ROUTES } from '../testing/preCutRoutes'
import type { IpcSenderEvent, SenderPolicy } from '../senderCheck'
import { createPanelRows, PANEL_ROWS } from './panel'

/**
 * The Panel window rows behind the router and its seam A gate (ADR-019 items 7, 8; ISSUE-044), routed `ui-local` as
 * ISSUE-056 routes them at cut 0 (14 §5): today's member names and shapes, kept (14 §2.1 KEEP, ADR-033 item 6), and
 * setters that answer the stored or real value (ADR-024 item 9; TC-047-02).
 */
describe('Panel window rows (14 §2.1 A-01…A-05, A-08, A-09, A-P1)', () => {
  const APP_ENTRY = 'file:///opt/DwarfAI/out/renderer/index.html'
  const senders: SenderPolicy = { appEntry: APP_ENTRY, isModeWindow: (id) => id === 1 }
  const fromPanel: IpcSenderEvent = { sender: { id: 1 }, senderFrame: { url: APP_ENTRY } }
  const UI_LOCAL = new Set<ChannelKey>([...PANEL_ROWS, PANEL_VISIBILITY_PUSH])

  /** The pre-cut-0 table with these rows switched to `ui-local`, as ISSUE-056 switches them. */
  const routes: ChannelRoute[] = PRE_CUT_0_ROUTES.map((route) =>
    UI_LOCAL.has(route.channel) ? { ...route, owner: 'ui-local', since: 'cut-0' } : route
  )
  const legacy: RouteTarget = {
    serve: (channel) => Promise.reject(new Error(`legacy must not serve ${channel}`))
  }

  class Surface implements PanelWindowSurface {
    pinned = false
    constructor(private readonly windows: FakeWindowFactory) {}
    applyZoom = (factor: number) => factor
    bounds = (): Rect => this.windows.panel().bounds ?? { x: 0, y: 0, width: 0, height: 0 }
    setAlwaysOnTop = (on: boolean) => (this.pinned = on)
    isAlwaysOnTop = () => this.pinned
    raise = () => undefined
    isMinimized = () => false
    onMinimizedChanged = () => undefined
  }

  function subject() {
    const storage = createInMemoryUiPreferenceStorage()
    const windows = new FakeWindowFactory()
    const panel = createPanelWindow({
      windows,
      surface: new Surface(windows),
      screen: new FakeScreenAreaProvider([
        {
          displayKey: 'primary',
          bounds: { x: 0, y: 0, width: 1920, height: 1080 },
          workArea: { x: 0, y: 0, width: 1920, height: 1040 },
          primary: true
        }
      ]),
      store: new InMemoryUiPreferenceStore(storage),
      floor: 32,
      onDisplaysChanged: () => undefined
    })
    const router = createRouter({ routes, legacy, uiLocal: createPanelRows(panel), senders })
    const call = (channel: ChannelKey, payload?: unknown) =>
      router.dispatch(channel, fromPanel, payload)
    return { call, panel, windows, storage }
  }

  /** The answer parses with the row's response schema, which for a KEEP row is today's shape. */
  function inShape(channel: ChannelKey, answer: unknown): unknown {
    expect(
      CHANNELS[channel].response.safeParse(answer).success,
      `${channel} answers in today's shape`
    ).toBe(true)
    return answer
  }

  it('[ADR-024] A-01…A-05, A-08, A-09 keep today’s member names and result shapes and every setter answers the stored value', async () => {
    const { call, panel, windows, storage } = subject()
    // Today's wire names (14 §2.1): the registry keys these handlers serve.
    expect([...PANEL_ROWS].sort()).toEqual(
      [
        'panel:hide',
        'panel:raise',
        'panel:getAlwaysOnTop',
        'panel:setAlwaysOnTop',
        'panel:visible:get',
        'panel:layout:get',
        'panel:layout:set'
      ].sort()
    )

    // A-03 / A-04: the pin as stored (on by default, #35); the setter answers what it stored.
    expect(inShape('panel:getAlwaysOnTop', await call('panel:getAlwaysOnTop'))).toBe(true)
    expect(inShape('panel:setAlwaysOnTop', await call('panel:setAlwaysOnTop', false))).toBe(false)
    expect(storage.stored.alwaysOnTop).toBe(false)
    expect(await call('panel:getAlwaysOnTop')).toBe(false)

    // A-08 / A-09: the layout; the setter answers the real layout and stores the edge it names.
    expect(inShape('panel:layout:get', await call('panel:layout:get'))).toEqual({
      edge: 'right',
      mineOpen: false,
      dockOpen: false
    })
    const layout = await call('panel:layout:set', { mineOpen: true, dockOpen: false, edge: 'left' })
    expect(inShape('panel:layout:set', layout)).toEqual({
      edge: 'left',
      mineOpen: true,
      dockOpen: false
    })
    expect(storage.stored.dockSide).toBe('left')
    expect(await call('panel:layout:get')).toEqual(layout)

    // A-05 and A-P1: the visibility, and the push that follows every change of it.
    expect(inShape('panel:visible:get', await call('panel:visible:get'))).toBe(false)
    panel.show()
    expect(await call('panel:visible:get')).toBe(true)
    // A-02 is one-way and answers nothing; it never changes the visibility.
    expect(await call('panel:raise')).toBeUndefined()
    // A-01 is one-way and answers nothing.
    expect(await call('panel:hide')).toBeUndefined()
    expect(await call('panel:visible:get')).toBe(false)
    const pushes = windows
      .panel()
      .pushes.filter((p) => p.push === PANEL_VISIBILITY_PUSH)
      .map((p) => inShape(PANEL_VISIBILITY_PUSH, p.payload))
    expect(pushes).toEqual([true, false])
  })

  it('[ADR-001] a ui-local row these handlers do not serve is refused with a typed error, never guessed', async () => {
    const { panel } = subject()
    const answer = await createPanelRows(panel).serve('audio:preferences:get', undefined)
    expect(answer).toEqual({
      ok: false,
      error: { code: 'METHOD_NOT_FOUND', message: expect.any(String), retryable: false }
    })
  })

  it('[ADR-019] a setter payload outside today’s shape is refused by the gate and never reaches a store', async () => {
    const { call, storage } = subject()
    await call('panel:setAlwaysOnTop', 'yes')
    await call('panel:layout:set', { mineOpen: true, dockOpen: false, edge: 'top' })
    expect(storage.stored).toEqual({})
  })
})
