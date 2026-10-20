// layer: L2
import type { DwarfId, MineId, ModeTransition } from '@dwarfai/contracts'
import { describe, expect, it } from 'vitest'
import { RecordingUiLog } from '../../hostLauncher/fakes/RecordingUiLog'
import { FakeModeTiming } from '../ports/fakes/FakeModeTiming'
import { InMemoryUiPreferenceStore } from '../ports/fakes/InMemoryUiPreferenceStore'
import { MODE_TRANSITION_PUSH } from './ModeCoordinator'
import { composeModeShell } from './modeShell'
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

function setup(start: 'hidden' | 'tray-only', shown = false) {
  const { panel, calls, state } = fakePanel(shown)
  const pushes: { push: string; payload: unknown }[] = []
  const timing = new FakeModeTiming()
  const store = new InMemoryUiPreferenceStore()
  const reveals: { mineId: MineId; dwarfId: DwarfId; existing: string | null }[] = []
  let ids = 0
  let revealWindows: RevealWindows | null = null
  const shell = composeModeShell({
    panel,
    pushToPanel: (push, payload) => pushes.push({ push, payload }),
    lastMode: createUiPreferences({ store, modeWindows: () => [] }),
    timing,
    log: new RecordingUiLog(),
    newTransitionId: () => `t-${(ids += 1)}`,
    start,
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
    windows: () => revealWindows
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
})
