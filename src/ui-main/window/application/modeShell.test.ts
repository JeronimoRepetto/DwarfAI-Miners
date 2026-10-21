// layer: L2
import type { DwarfId, MineId, ModeTransition } from '@dwarfai/contracts'
import { describe, expect, it } from 'vitest'
import { RecordingUiLog } from '../../hostLauncher/fakes/RecordingUiLog'
import { FakeModeTiming } from '../ports/fakes/FakeModeTiming'
import { InMemoryUiPreferenceStore } from '../ports/fakes/InMemoryUiPreferenceStore'
import { MODE_TRANSITION_PUSH } from './ModeCoordinator'
import { FakeModeWindow } from '../ports/fakes/FakeWindowFactory'
import { BUILT_MODES, composeModeShell, type ModeShellDeps } from './modeShell'
import type { PanelWindowUseCases } from './panelWindow'
import type { RevealWindows } from './revealDwarfChat'
import { createUiPreferences } from './uiPreferences'

const DWARF = '018f3a2e-7c4b-7d1e-9a5b-2f6c8d0e1a01' as DwarfId
const MINE = '018f3a2e-7c4b-7d1e-9a5b-2f6c8d0e1a02' as MineId

/** The Panel window use cases as a recording double: what was called, and whether the window is shown. */
function fakePanel(shown: boolean) {
  const calls: string[] = []
  const state = { shown }
  const panel: PanelWindowUseCases = {
    hide: () => {
      calls.push('hide')
      state.shown = false
    },
    show: () => {
      calls.push('show')
      state.shown = true
    },
    toggleVisible: () => calls.push('toggleVisible'),
    setAlwaysOnTop: (on) => on,
    layout: () => ({ edge: 'right', mineOpen: false, dockOpen: false }),
    setLayout: (r) => ({ edge: r.edge ?? 'right', mineOpen: r.mineOpen, dockOpen: r.dockOpen }),
    raise: () => calls.push('raise'),
    alwaysOnTop: () => true,
    visible: () => state.shown,
    isShown: () => state.shown,
    holdPlacement: () => {},
    panelStart: () => ({ alwaysOnTop: true, bounds: { x: 0, y: 0, width: 420, height: 900 } }),
    load: () => calls.push('load')
  }
  return { panel, calls, state }
}

function setup(start: 'hidden' | 'tray-only', shown = false, extra: Partial<ModeShellDeps> = {}) {
  const { panel, calls, state } = fakePanel(shown)
  const pushes: { push: string; payload: unknown }[] = []
  const timing = new FakeModeTiming()
  const store = new InMemoryUiPreferenceStore()
  const reveals: { mineId: MineId; dwarfId: DwarfId; existing: string | null }[] = []
  let ids = 0
  let revealWindows: RevealWindows | null = null
  const departures: ((dwarfId: DwarfId) => void)[] = []
  const closings: (() => void)[] = []
  const shell = composeModeShell({
    departures: (h) => {
      departures.push(h)
      return () => {}
    },
    hostClosing: (h) => {
      closings.push(h)
      return () => {}
    },
    panel,
    pushToPanel: (push, payload) => pushes.push({ push, payload }),
    lastMode: createUiPreferences({ store, modeWindows: () => [] }),
    timing,
    log: new RecordingUiLog(),
    newTransitionId: () => `t-${(ids += 1)}`,
    start,
    ...extra,
    revealer: (windows) => {
      revealWindows = windows
      return {
        async revealDwarfChat(t) {
          const existing = windows.existing()
          if (existing === null) await windows.openAtLaunch()
          else windows.restore(existing)
          reveals.push({ ...t, existing })
          return 'chat-open'
        }
      }
    }
  })
  const transitions = (): ModeTransition[] =>
    pushes.filter((p) => p.push === MODE_TRANSITION_PUSH).map((p) => p.payload as ModeTransition)
  /** The Panel's renderer answers the last run it was told. */
  const answer = (): void => {
    const last = transitions().at(-1)
    if (last !== undefined)
      shell.coordinator.transitionDone('panel', { transitionId: last.transitionId })
  }
  return {
    shell,
    calls,
    state,
    transitions,
    answer,
    reveals,
    store,
    timing,
    windows: () => revealWindows,
    depart: (dwarfId: DwarfId) => departures.forEach((h) => h(dwarfId)),
    hostClose: () => closings.forEach((h) => h())
  }
}

describe('the mode shell over the Panel (ISSUE-284; ADR-025 item 3; 07 S10.08, S10.09)', () => {
  it('[S10.08, S10.09] the shortcut, Settings Hide panel and the tray hide and show the Panel as ModeTransitions to and from hidden', async () => {
    const s = setup('hidden')
    // The shortcut (or the tray's Open) on a hidden Panel: a run from hidden, the Panel shown, then focused.
    s.shell.panel.toggleVisible()
    expect(s.transitions()).toMatchObject([{ from: 'hidden', to: 'panel', role: 'target' }])
    expect(s.calls).toEqual(['show'])
    s.answer()
    await Promise.resolve()
    expect(s.calls).toEqual(['show', 'raise'])
    expect(s.shell.coordinator.mode()).toBe('panel')

    // Settings "Hide panel" (A-01): a run to hidden; the Panel hides once its renderer answered.
    s.shell.panel.hide()
    expect(s.transitions().at(-1)).toMatchObject({ from: 'panel', to: 'hidden', role: 'source' })
    expect(s.calls).not.toContain('hide')
    s.answer()
    expect(s.calls.at(-1)).toBe('hide')
    expect(s.shell.coordinator.mode()).toBe('hidden')

    // The shortcut on the hidden Panel again, then the tray's Open on a shown one: one run, nothing more.
    s.shell.panel.toggleVisible()
    s.answer()
    const before = s.transitions().length
    s.shell.panel.show()
    expect(s.transitions()).toHaveLength(before)
    // The Panel's own toggle is never called: every hide and show is the coordinator's.
    expect(s.calls).not.toContain('toggleVisible')
    expect(s.store.load('lastMode')).toBe('panel')
  })

  it('[S10.11, S27.14] a notification click on a hidden Panel restores it through the coordinator and reveals there', async () => {
    const s = setup('hidden')
    const revealed = s.shell.coordinator.revealDwarfChat({ mineId: MINE, dwarfId: DWARF })
    expect(await revealed).toBe('chat-open')
    expect(s.reveals).toEqual([{ mineId: MINE, dwarfId: DWARF, existing: 'panel' }])
    expect(s.transitions()).toMatchObject([{ from: 'hidden', to: 'panel' }])
  })

  it('[S10.12, S10.14] with no window open a click opens the Panel as a launch does; the last window closed enters tray-only', async () => {
    const s = setup('tray-only')
    expect(s.windows()?.existing()).toBeNull()
    const revealed = s.shell.coordinator.revealDwarfChat({ mineId: MINE, dwarfId: DWARF })
    await Promise.resolve()
    s.answer()
    expect(await revealed).toBe('chat-open')
    expect(s.shell.coordinator.ladder()).toEqual({ state: 'panel', lastId: 'S10.12' })
    s.shell.coordinator.closed('windows-closed')
    expect(s.shell.coordinator.ladder()).toEqual({ state: 'tray-only', lastId: 'S10.14' })
    expect(s.state.shown).toBe(false)
  })

  it('[S27.11, S10.16] the Host dwarf.departed frame and its clean close reach the coordinator from the composition', async () => {
    const s = setup('hidden')
    const moved = s.shell.coordinator.moveToMode({ mode: 'panel', mineId: MINE, dwarfId: DWARF })
    expect(s.shell.coordinator.mode()).toBe('hidden')
    // The carried dwarf left mid-run: the run completes at once (S27.11), no renderer answer needed.
    s.depart(DWARF)
    expect(s.shell.coordinator.mode()).toBe('panel')
    expect(await moved).toEqual({ ok: true, value: undefined })

    const tray = setup('tray-only')
    tray.hostClose()
    expect(tray.shell.coordinator.ladder()).toEqual({ state: 'not-running', lastId: 'S10.16' })
  })
})

describe('the mode shell with a Veta window (ISSUE-285; ADR-025 items 1, 3)', () => {
  it('[ADR-025, BR-19] a release build ships the Panel alone, so no move reaches a Veta window', async () => {
    expect(BUILT_MODES).toEqual(['panel'])
    const veta = new FakeModeWindow()
    const s = setup('hidden', false, {
      veta: { window: () => veta, bounds: () => ({ x: 0, y: 1000, width: 480, height: 72 }) }
    })
    expect(await s.shell.coordinator.moveToMode({ mode: 'veta' })).toMatchObject({ ok: false })
    expect(veta.calls).toEqual([])
  })

  it('[ADR-025, NFR-PLAT-02] where Veta is built, a move to Veta places its window at its final bounds and shows it through the coordinator', async () => {
    const veta = new FakeModeWindow()
    const bounds = { x: 1920, y: 1328, width: 480, height: 72 }
    const s = setup('hidden', false, {
      built: ['panel', 'veta'],
      veta: { window: () => veta, bounds: () => bounds }
    })
    s.shell.panel.toggleVisible()
    s.answer()
    await Promise.resolve()
    const moved = s.shell.coordinator.moveToMode({ mode: 'veta' })
    expect(veta.calls.slice(0, 2)).toEqual([
      { member: 'placeAt', bounds },
      { member: 'showInactive' }
    ])
    const run = s.transitions().at(-1)!
    expect(run).toMatchObject({ from: 'panel', to: 'veta', role: 'source' })
    expect(veta.pushes.map((p) => p.push)).toEqual([MODE_TRANSITION_PUSH])
    s.answer()
    s.shell.coordinator.transitionDone('veta', { transitionId: run.transitionId })
    expect(await moved).toEqual({ ok: true, value: undefined })
    expect(s.calls.at(-1)).toBe('hide')
    expect(veta.focused).toBe(true)
    expect(s.store.load('lastMode')).toBe('veta')
    // Back to the Panel: Veta hides, never closes (ADR-025 item 1).
    const back = s.shell.coordinator.moveToMode({ mode: 'panel' })
    const second = s.transitions().at(-1)!
    s.answer()
    s.shell.coordinator.transitionDone('veta', { transitionId: second.transitionId })
    expect(await back).toEqual({ ok: true, value: undefined })
    expect(veta.visible).toBe(false)
  })

  it('[S24.15, ADR-025] a notification click while Veta is shown reveals in Veta, never moving the mode', async () => {
    const veta = new FakeModeWindow()
    const s = setup('hidden', false, {
      built: ['panel', 'veta'],
      veta: { window: () => veta, bounds: () => ({ x: 1920, y: 1328, width: 480, height: 72 }) }
    })
    s.shell.panel.toggleVisible()
    s.answer()
    await Promise.resolve()
    const moved = s.shell.coordinator.moveToMode({ mode: 'veta' })
    const run = s.transitions().at(-1)!
    s.answer()
    s.shell.coordinator.transitionDone('veta', { transitionId: run.transitionId })
    await moved
    const runs = s.transitions().length
    expect(await s.shell.coordinator.revealDwarfChat({ mineId: MINE, dwarfId: DWARF })).toBe(
      'chat-open'
    )
    // The Veta window reveals it (07 S24.15): the mode stays the person's (S10.10).
    expect(s.reveals).toEqual([{ mineId: MINE, dwarfId: DWARF, existing: 'veta' }])
    expect(s.shell.coordinator.mode()).toBe('veta')
    expect(s.transitions()).toHaveLength(runs)
  })

  it('[ADR-002, S10.18] a confirmation the Panel shows, asked for while Veta is shown, moves to the Panel first', async () => {
    const veta = new FakeModeWindow()
    const s = setup('hidden', false, {
      built: ['panel', 'veta'],
      veta: { window: () => veta, bounds: () => ({ x: 0, y: 1000, width: 480, height: 72 }) }
    })
    s.shell.panel.toggleVisible()
    s.answer()
    await Promise.resolve()
    const toVeta = s.shell.coordinator.moveToMode({ mode: 'veta' })
    s.answer()
    s.shell.coordinator.transitionDone('veta', {
      transitionId: s.transitions().at(-1)!.transitionId
    })
    await toVeta
    expect(s.shell.coordinator.mode()).toBe('veta')
    // Stop everything and quit's confirmation surface is the Panel (US-RES-002.AC08): the Panel is shown at once,
    // inactive, as the target of a run from Veta, so the dialog pushed next is on screen.
    s.shell.surfacePanel()
    expect(s.state.shown).toBe(true)
    expect(s.transitions().at(-1)).toMatchObject({ from: 'veta', to: 'panel', role: 'target' })
    // From hidden it is the ordinary restore (S10.09).
    const h = setup('hidden')
    h.shell.surfacePanel()
    expect(h.transitions()).toMatchObject([{ from: 'hidden', to: 'panel' }])
  })
})
