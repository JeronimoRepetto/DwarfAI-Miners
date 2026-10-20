// layer: L2
import type { DwarfId, MineId, ModeTransition } from '@dwarfai/contracts'
import { describe, expect, it } from 'vitest'
import { RecordingUiLog } from '../../hostLauncher/fakes/RecordingUiLog'
import { FakeModeTiming } from '../ports/fakes/FakeModeTiming'
import { FakeWindowFactory, type FakeModeWindow } from '../ports/fakes/FakeWindowFactory'
import { InMemoryUiPreferenceStore } from '../ports/fakes/InMemoryUiPreferenceStore'
import type { Rect } from '../ports/windowFactory'
import {
  createModeCoordinator,
  MODE_TRANSITION_PUSH,
  type AppMode,
  type ModeCoordinator,
  type ModeCoordinatorStart
} from './ModeCoordinator'
import { createUiPreferences } from './uiPreferences'

const DWARF = '018f3a2e-7c4b-7d1e-9a5b-2f6c8d0e1a01' as DwarfId
const MINE = '018f3a2e-7c4b-7d1e-9a5b-2f6c8d0e1a02' as MineId
const BOUNDS: Readonly<Record<AppMode, Rect>> = {
  panel: { x: 1500, y: 0, width: 420, height: 1040 },
  veta: { x: 0, y: 980, width: 640, height: 60 },
  valle: { x: 0, y: 0, width: 1920, height: 1040 }
}
/** S27.02: M = 270 ms; the watchdog is M + 40 ms from `t0`, and `t0` is the clock + 16 ms. */
const T0_LEAD = 16
const WATCHDOG = 270 + 40

interface Setup {
  coordinator: ModeCoordinator
  timing: FakeModeTiming
  store: InMemoryUiPreferenceStore
  log: RecordingUiLog
  win: Record<AppMode, FakeModeWindow>
  failing: Set<AppMode>
  reveals: { mineId: MineId; dwarfId: DwarfId; shown: string }[]
  reduced: { on: boolean }
  /** The windows brought forward while already shown (S10.02). */
  forwards: AppMode[]
  /** Each start (`true`) and end (`false`) of a run's motion, as the coordinator reports it (NFR-PERF-02). */
  runs: boolean[]
  /** The next reveal fails with this error. */
  revealFails: { error: Error | null }
}

function setup(
  options: { built?: readonly AppMode[]; start?: ModeCoordinatorStart; lastMode?: AppMode } = {}
): Setup {
  const factory = new FakeWindowFactory()
  const win: Record<AppMode, FakeModeWindow> = {
    panel: factory.panel(),
    veta: factory.veta('display-1'),
    valle: factory.valle('display-1')
  }
  const timing = new FakeModeTiming()
  const store = new InMemoryUiPreferenceStore()
  if (options.lastMode !== undefined) store.save('lastMode', options.lastMode)
  const prefs = createUiPreferences({ store, modeWindows: () => [] })
  const log = new RecordingUiLog()
  const failing = new Set<AppMode>()
  const reveals: Setup['reveals'] = []
  const reduced = { on: false }
  const forwards: AppMode[] = []
  const runs: boolean[] = []
  const revealFails: Setup['revealFails'] = { error: null }
  let next = 0
  const start = options.start ?? 'panel'
  if (start !== 'tray-only' && start !== 'hidden') win[start].showInactive()
  for (const window of Object.values(win)) window.calls.length = 0
  const coordinator = createModeCoordinator({
    windows: {
      window(mode) {
        if (failing.has(mode)) throw new Error(`the ${mode} window cannot be shown`)
        return win[mode]
      },
      bounds: (mode) => BOUNDS[mode],
      bringForward: (mode) => void forwards.push(mode),
      isShown: (mode) => win[mode].visible
    },
    timing,
    lastMode: prefs,
    built: options.built ?? ['panel', 'veta', 'valle'],
    revealer: {
      revealDwarfChat(t) {
        if (revealFails.error !== null) return Promise.reject(revealFails.error)
        reveals.push({ ...t, shown: coordinator.mode() })
        return Promise.resolve('chat-open')
      }
    },
    log,
    newTransitionId: () => `t-${(next += 1)}`,
    reducedMotion: () => reduced.on,
    onRunChanged: (playing) => void runs.push(playing),
    start
  })
  return {
    coordinator,
    timing,
    store,
    log,
    win,
    failing,
    reveals,
    reduced,
    forwards,
    runs,
    revealFails
  }
}

/** The `mode.transition` pushes `window` got, in order. */
function transitions(window: FakeModeWindow): ModeTransition[] {
  return window.pushes
    .filter((p) => p.push === MODE_TRANSITION_PUSH)
    .map((p) => p.payload as ModeTransition)
}

/** Both renderers of the running run answer `done`. */
function bothDone(s: Setup, from: AppMode | null, to: AppMode | null): void {
  for (const mode of [from, to]) {
    if (mode === null) continue
    const sent = transitions(s.win[mode]).at(-1)
    if (sent !== undefined) s.coordinator.transitionDone(mode, { transitionId: sent.transitionId })
  }
}

function shownWindows(s: Setup): AppMode[] {
  return (Object.keys(s.win) as AppMode[]).filter((mode) => s.win[mode].visible)
}

describe('ModeCoordinator (ADR-025 item 3; 07 machine 27)', () => {
  it('[US-VETA-009.AC01, S27.01] the target window is placed at its final bounds, content at opacity 0, and shown inactive before t0, already open on the named mine and chat', () => {
    const s = setup({ start: 'veta' })
    void s.coordinator.moveToMode({ mode: 'panel', mineId: MINE, dwarfId: DWARF })

    // Placed, then shown inactive, then told the run: never shown before it is at its final bounds.
    expect(s.win.panel.calls.map((c) => c.member)).toEqual(['placeAt', 'showInactive', 'send'])
    expect(s.win.panel.bounds).toEqual(BOUNDS.panel)
    expect(s.win.panel.focused).toBe(false)
    // The target role keeps its content at opacity 0 until t0; it opens on the named mine and chat.
    const sent = transitions(s.win.panel)[0]!
    expect(sent.role).toBe('target')
    expect(sent.chat).toEqual({ dwarfId: DWARF, mineId: MINE })
    expect(sent.t0).toBeGreaterThan(s.timing.now())
  })

  it('[US-VETA-009.AC02, S27.02] both renderers receive one mode.transition with the same t0, clock plus 16 ms, and their own role', () => {
    const s = setup({ start: 'panel' })
    const clock = s.timing.now()
    void s.coordinator.moveToMode({ mode: 'veta' })

    const toSource = transitions(s.win.panel)
    const toTarget = transitions(s.win.veta)
    expect(toSource).toHaveLength(1)
    expect(toTarget).toHaveLength(1)
    expect(toSource[0]).toEqual({
      transitionId: 't-1',
      from: 'panel',
      to: 'veta',
      t0: clock + T0_LEAD,
      role: 'source'
    })
    expect(toTarget[0]).toEqual({ ...toSource[0], role: 'target' })
  })

  it('[US-VETA-009.AC04, NFR-PERF-02, ADR-025] no setBounds call happens between t0 and the second done', () => {
    const s = setup({ start: 'panel' })
    void s.coordinator.moveToMode({ mode: 'veta' })
    s.timing.advance(T0_LEAD + 100)
    s.coordinator.transitionDone('panel', { transitionId: 't-1' })
    s.timing.advance(50)
    s.coordinator.transitionDone('veta', { transitionId: 't-1' })

    // From the moment each window was told the run (its `mode.transition`) to the landing, nothing is placed.
    const sinceT0 = Object.values(s.win).flatMap((w) => {
      const told = w.calls.findIndex((c) => c.member === 'send')
      return told === -1 ? [] : w.calls.slice(told)
    })
    expect(sinceT0.filter((c) => c.member === 'placeAt')).toEqual([])
    expect(s.win.veta.focused).toBe(true)
  })

  it('[S27.03, S27.04, NFR-TIM-16] the source hides and the target focuses on both done or at the M plus 40 ms watchdog, and lastMode becomes the target', async () => {
    const byDone = setup({ start: 'panel' })
    const answered = byDone.coordinator.moveToMode({ mode: 'veta' })
    bothDone(byDone, 'panel', 'veta')
    expect(await answered).toEqual({ ok: true, value: undefined })
    expect(byDone.win.panel.visible).toBe(false)
    expect(byDone.win.veta.focused).toBe(true)
    expect(byDone.store.load('lastMode')).toBe('veta')

    const byWatchdog = setup({ start: 'panel' })
    const late = byWatchdog.coordinator.moveToMode({ mode: 'valle' })
    byWatchdog.coordinator.transitionDone('panel', { transitionId: 't-1' })
    byWatchdog.timing.advance(T0_LEAD + WATCHDOG - 1)
    expect(byWatchdog.win.panel.visible).toBe(true)
    expect(byWatchdog.store.load('lastMode')).toBe('panel')
    byWatchdog.timing.advance(1)
    expect(await late).toEqual({ ok: true, value: undefined })
    expect(byWatchdog.win.panel.visible).toBe(false)
    expect(byWatchdog.win.valle.focused).toBe(true)
    expect(byWatchdog.store.load('lastMode')).toBe('valle')
  })

  it('[S27.07, FM-046] a target that cannot be shown leaves the source shown and logs window.transition-failed', () => {
    const s = setup({ start: 'panel' })
    s.failing.add('veta')
    void s.coordinator.moveToMode({ mode: 'veta' })

    expect(s.coordinator.mode()).toBe('panel')
    expect(s.win.panel.visible).toBe(true)
    expect(transitions(s.win.panel)).toEqual([])
    expect(s.store.load('lastMode')).toBe('panel')
    expect(s.log.byEvent('window.transition-failed')).toEqual([
      { level: 'warn', event: 'window.transition-failed', subsystem: 'window', msg: 'panel->veta' }
    ])
  })

  it('[S27.09] a second moveToMode during a run is held and runs as soon as the run settles, and a third replaces the held one so the last request wins', async () => {
    // OQ-78, AMENDMENT-10: the mode can always be changed; a request during a run is held, never dropped.
    const s = setup({ start: 'panel' })
    const first = s.coordinator.moveToMode({ mode: 'veta' })
    const second = s.coordinator.moveToMode({ mode: 'valle' })
    const third = s.coordinator.moveToMode({ mode: 'panel' })
    // Held: no second run started while the first plays.
    expect(transitions(s.win.valle)).toEqual([])
    expect(transitions(s.win.panel)).toHaveLength(1)

    bothDone(s, 'panel', 'veta')
    expect(await first).toEqual({ ok: true, value: undefined })
    // The last request (back to the Panel) runs at once, from Veta; the replaced one never runs.
    expect(transitions(s.win.panel).at(-1)).toMatchObject({
      from: 'veta',
      to: 'panel',
      role: 'target'
    })
    expect(transitions(s.win.valle)).toEqual([])

    bothDone(s, 'veta', 'panel')
    expect(await third).toEqual({ ok: true, value: undefined })
    // The replaced request resolves with the move that replaced it.
    expect(await second).toEqual({ ok: true, value: undefined })
    expect(s.coordinator.mode()).toBe('panel')
  })

  it('[S27.07, FM-046] a window that throws while it is told the run, or while it lands, leaves the coordinator settled', async () => {
    const s = setup({ start: 'panel' })
    // Told the run: the target cannot take it, so the source stays (S27.07) and the request is answered INTERNAL.
    s.win.veta.send = () => {
      throw new Error('the Veta renderer is gone')
    }
    expect(await s.coordinator.moveToMode({ mode: 'veta' })).toMatchObject({
      ok: false,
      error: { code: 'INTERNAL', retryable: false }
    })
    expect(shownWindows(s)).toEqual(['panel'])
    expect(s.log.byEvent('window.transition-failed')).toHaveLength(1)

    // Landing: the source cannot be hidden; the run still settles in the target and the next move runs.
    s.win.panel.hide = () => {
      throw new Error('the Panel window is gone')
    }
    const moved = s.coordinator.moveToMode({ mode: 'valle' })
    bothDone(s, 'panel', 'valle')
    expect(await moved).toEqual({ ok: true, value: undefined })
    expect(s.coordinator.mode()).toBe('valle')
    s.win.veta.send = () => {}
    const next = s.coordinator.moveToMode({ mode: 'veta' })
    expect(transitions(s.win.valle).at(-1)).toMatchObject({ from: 'valle', to: 'veta' })
    s.timing.advance(1_000)
    expect(await next).toEqual({ ok: true, value: undefined })
  })

  it('[S27.09] a click or a key during a run that is not a mode request is ignored, never queued', async () => {
    const s = setup({ start: 'panel' })
    const moved = s.coordinator.moveToMode({ mode: 'veta' })
    const calls = Object.values(s.win).map((w) => w.calls.length)
    s.coordinator.input()
    s.coordinator.input()
    expect(Object.values(s.win).map((w) => w.calls.length)).toEqual(calls)

    bothDone(s, 'panel', 'veta')
    await moved
    // Nothing ran after the run settled: the inputs were not queued.
    const settled = Object.values(s.win).map((w) => w.calls.length)
    s.timing.advance(10_000)
    expect(Object.values(s.win).map((w) => w.calls.length)).toEqual(settled)
    expect(s.coordinator.mode()).toBe('veta')
  })

  it('[S27.07] a moveToMode whose target cannot be shown resolves INTERNAL, not retryable, and the source stays', async () => {
    // OQ-78, AMENDMENT-10: the one failure answer; the details go to the log only (14 §1.5).
    const s = setup({ start: 'panel' })
    s.failing.add('valle')
    expect(await s.coordinator.moveToMode({ mode: 'valle' })).toEqual({
      ok: false,
      error: { code: 'INTERNAL', message: 'the mode window could not be shown', retryable: false }
    })
    expect(shownWindows(s)).toEqual(['panel'])
  })

  it('[S27.14] a reveal arriving mid-run is held, the latest one wins, and it is applied in the target mode', async () => {
    const s = setup({ start: 'panel' })
    const moved = s.coordinator.moveToMode({ mode: 'veta' })
    const older = s.coordinator.revealDwarfChat({ mineId: MINE, dwarfId: DWARF })
    const OTHER = '018f3a2e-7c4b-7d1e-9a5b-2f6c8d0e1a03' as DwarfId
    const latest = s.coordinator.revealDwarfChat({ mineId: MINE, dwarfId: OTHER })
    expect(s.reveals).toEqual([])

    bothDone(s, 'panel', 'veta')
    await moved
    expect(await latest).toBe('chat-open')
    expect(await older).toBe('chat-open')
    expect(s.reveals).toEqual([{ mineId: MINE, dwarfId: OTHER, shown: 'veta' }])
  })

  it('[S27.11] a departed carried dwarf completes the run at once, and another dwarf leaving changes nothing', async () => {
    const s = setup({ start: 'veta' })
    const moved = s.coordinator.moveToMode({ mode: 'panel', mineId: MINE, dwarfId: DWARF })
    s.coordinator.departed('018f3a2e-7c4b-7d1e-9a5b-2f6c8d0e1a09' as DwarfId)
    expect(s.win.veta.visible).toBe(true)
    s.coordinator.departed(DWARF)
    expect(await moved).toEqual({ ok: true, value: undefined })
    expect(shownWindows(s)).toEqual(['panel'])
    expect(s.store.load('lastMode')).toBe('panel')
  })

  it('[S27.14] a held reveal whose reveal fails settles its callers with that failure', async () => {
    const s = setup({ start: 'panel' })
    const moved = s.coordinator.moveToMode({ mode: 'veta' })
    const held = s.coordinator.revealDwarfChat({ mineId: MINE, dwarfId: DWARF })
    const settled = held.then(
      () => 'resolved',
      (error: Error) => error.message
    )
    s.revealFails.error = new Error('the reveal failed')
    bothDone(s, 'panel', 'veta')
    await moved
    expect(await settled).toBe('the reveal failed')
  })

  it('[S10.15, S27.10] Quit drops a held reveal and opens nothing', async () => {
    const s = setup({ start: 'panel' })
    void s.coordinator.moveToMode({ mode: 'veta' })
    const held = s.coordinator.revealDwarfChat({ mineId: MINE, dwarfId: DWARF })
    const settled = held.then(
      () => 'revealed',
      () => 'dropped'
    )
    s.coordinator.closed('quit')
    expect(await settled).toBe('dropped')
    expect(s.reveals).toEqual([])
    expect(shownWindows(s)).toEqual([])
    expect(s.coordinator.ladder()).toEqual({ state: 'tray-only', lastId: 'S10.15' })
  })

  it('[S10.08, S10.09] hide and restore run as ModeTransitions to and from hidden, and restore shows lastMode', async () => {
    const s = setup({ start: 'panel' })
    const hidden = s.coordinator.hide()
    expect(transitions(s.win.panel)).toEqual([
      {
        transitionId: 't-1',
        from: 'panel',
        to: 'hidden',
        t0: s.timing.now() + T0_LEAD,
        role: 'source'
      }
    ])
    bothDone(s, 'panel', null)
    expect(await hidden).toEqual({ ok: true, value: undefined })
    expect(shownWindows(s)).toEqual([])
    expect(s.coordinator.mode()).toBe('hidden')
    // `lastMode` is never `hidden`: restoring shows the mode shown last.
    expect(s.store.load('lastMode')).toBe('panel')

    const restored = s.coordinator.restore()
    expect(transitions(s.win.panel).at(-1)).toMatchObject({
      from: 'hidden',
      to: 'panel',
      role: 'target'
    })
    bothDone(s, null, 'panel')
    expect(await restored).toEqual({ ok: true, value: undefined })
    expect(shownWindows(s)).toEqual(['panel'])
    expect(s.win.panel.focused).toBe(true)

    // A hide during a run resolves it at once (S27.08): hidden, lastMode the target, restoring shows the target.
    const moving = s.coordinator.moveToMode({ mode: 'veta' })
    await s.coordinator.hide()
    expect(await moving).toEqual({ ok: true, value: undefined })
    expect(shownWindows(s)).toEqual([])
    expect(s.store.load('lastMode')).toBe('veta')
    const back = s.coordinator.restore()
    bothDone(s, null, 'veta')
    await back
    expect(shownWindows(s)).toEqual(['veta'])
  })

  it('[S27.08] the shortcut during a run from hidden hides the window at once instead of restoring it', async () => {
    const s = setup({ start: 'hidden' })
    void s.coordinator.restore()
    expect(transitions(s.win.panel).at(-1)).toMatchObject({ from: 'hidden', to: 'panel' })
    // The press lands mid-motion: the person asked for the opposite of where the run is going.
    const pressed = s.coordinator.toggle()
    s.timing.advance(400)
    expect(shownWindows(s)).toEqual([])
    expect(s.coordinator.mode()).toBe('hidden')
    expect(await pressed).toEqual({ ok: true, value: undefined })
  })

  it('[S10.08, S10.09] a hide the coordinator did not run is read back before the shortcut decides, so one press shows the window', async () => {
    const s = setup({ start: 'panel' })
    // macOS Cmd+H or app.hide(): the window went off screen without a run.
    s.win.panel.visible = false
    const pressed = s.coordinator.toggle()
    expect(transitions(s.win.panel).at(-1)).toMatchObject({
      from: 'hidden',
      to: 'panel',
      role: 'target'
    })
    bothDone(s, null, 'panel')
    expect(await pressed).toEqual({ ok: true, value: undefined })
    expect(shownWindows(s)).toEqual(['panel'])
  })

  it('[S10.13, S10.02] tray Open from tray-only opens the mode shown last as a launch does, and a restore when shown brings it forward with no run', async () => {
    const s = setup({ start: 'tray-only' })
    const opened = s.coordinator.restore()
    bothDone(s, null, 'panel')
    expect(await opened).toEqual({ ok: true, value: undefined })
    expect(s.coordinator.ladder()).toEqual({ state: 'panel', lastId: 'S10.13' })
    expect(shownWindows(s)).toEqual(['panel'])
    const calls = s.win.panel.calls.length
    expect(await s.coordinator.restore()).toEqual({ ok: true, value: undefined })
    // CORRECTED (independent review, finding 1): a restore of the mode already shown is still a request to see it —
    // a second launch (S10.02), the tray's Open or Stop everything's confirmation — so the window comes forward,
    // un-minimized, as the Panel's own show did before the coordinator; it is not a run.
    expect(s.forwards).toEqual(['panel'])
    expect(s.win.panel.calls).toHaveLength(calls)
  })

  it('[BR-19, ADR-034] a mode that is not built is never offered, and a move to it starts no run', async () => {
    const s = setup({ start: 'panel', built: ['panel'] })
    expect(s.coordinator.offered()).toEqual(['panel'])
    // CORRECTED (independent review, finding 8a): AMENDMENT-10 and 14 §2.2 Notes allow A-N13 only `{ ok: true }` or
    // `INTERNAL`, not retryable; the contract wins over the earlier NOT_SUPPORTED reading.
    expect(await s.coordinator.moveToMode({ mode: 'veta' })).toEqual({
      ok: false,
      error: { code: 'INTERNAL', message: 'veta is not built', retryable: false }
    })
    expect(Object.values(s.win).flatMap((w) => w.calls)).toEqual([])
    expect(s.coordinator.mode()).toBe('panel')
  })

  it('[S27.12, S10.17, S10.01] a crash mid-run does not dead-end the coordinator: a later move recovers', async () => {
    const s = setup({ start: 'panel' })
    void s.coordinator.moveToMode({ mode: 'veta' })
    s.coordinator.crashed()
    expect(s.coordinator.ladder()).toEqual({ state: 'not-running', lastId: 'S10.17' })
    const back = s.coordinator.moveToMode({ mode: 'panel' })
    bothDone(s, null, 'panel')
    s.timing.advance(1_000)
    expect(await back).toEqual({ ok: true, value: undefined })
    expect(s.coordinator.mode()).toBe('panel')
    expect(s.coordinator.ladder()).toEqual({ state: 'panel', lastId: 'S10.01' })
  })

  it('[INV-116, S27.04, S27.07, S27.08, S27.09] exactly one mode window is shown after every run, however it ends', async () => {
    const s = setup({ start: 'panel' })
    const path: [AppMode, AppMode][] = [
      ['panel', 'veta'],
      ['veta', 'valle'],
      ['valle', 'panel'],
      ['panel', 'valle'],
      ['valle', 'veta'],
      ['veta', 'panel']
    ]
    for (const [from, to] of path) {
      const moved = s.coordinator.moveToMode({ mode: to })
      bothDone(s, from, to)
      await moved
      expect(shownWindows(s)).toEqual([to])
    }
    // Ended by the watchdog (S27.04): no renderer answered.
    const byWatchdog = s.coordinator.moveToMode({ mode: 'veta' })
    s.timing.advance(1_000)
    await byWatchdog
    expect(shownWindows(s), 'after the watchdog').toEqual(['veta'])
    // Ended by a target that cannot be shown (S27.07).
    s.failing.add('valle')
    await s.coordinator.moveToMode({ mode: 'valle' })
    expect(shownWindows(s), 'after a failed target').toEqual(['veta'])
    s.failing.clear()
    // Ended by a hide mid-motion (S27.08): no window at all, the hidden rung.
    const hiddenMidway = s.coordinator.moveToMode({ mode: 'panel' })
    await s.coordinator.hide()
    await hiddenMidway
    expect(shownWindows(s), 'after a hide mid-motion').toEqual([])
    // Ended by a held request (S27.09): the restore runs, then the request held during it.
    const restored = s.coordinator.restore()
    const heldMove = s.coordinator.moveToMode({ mode: 'valle' })
    bothDone(s, null, 'panel')
    await restored
    bothDone(s, 'panel', 'valle')
    await heldMove
    expect(shownWindows(s), 'after a held request').toEqual(['valle'])
  })

  it('[S10.06, S10.07, S10.12, S10.16, S10.17] every machine 10 transition reaches its target: Open Valle from Veta, Panel or Veta from Valle, a notification click with no window opening per Mode at launch and then revealing, a clean Host close from tray-only, and a UI crash to not-running; a transition 07 does not list is rejected', async () => {
    const s = setup({ start: 'tray-only' })
    const ladder = (): string => s.coordinator.ladder().state
    expect(ladder()).toBe('tray-only')

    // S10.12: a notification click with no window open opens per "Mode at launch", then reveals there.
    const clicked = s.coordinator.revealAtLaunch('veta', { mineId: MINE, dwarfId: DWARF })
    bothDone(s, null, 'veta')
    expect(await clicked).toBe('chat-open')
    expect(s.coordinator.ladder()).toEqual({ state: 'veta', lastId: 'S10.12' })
    expect(s.reveals).toEqual([{ mineId: MINE, dwarfId: DWARF, shown: 'veta' }])

    const table: [() => Promise<unknown>, AppMode | null, AppMode | null, string, string][] = [
      [() => s.coordinator.moveToMode({ mode: 'valle' }), 'veta', 'valle', 'valle', 'S10.06'],
      [() => s.coordinator.moveToMode({ mode: 'panel' }), 'valle', 'panel', 'panel', 'S10.07'],
      [() => s.coordinator.moveToMode({ mode: 'valle' }), 'panel', 'valle', 'valle', 'S10.04'],
      [() => s.coordinator.moveToMode({ mode: 'veta' }), 'valle', 'veta', 'veta', 'S10.07'],
      [() => s.coordinator.moveToMode({ mode: 'panel' }), 'veta', 'panel', 'panel', 'S10.05'],
      [() => s.coordinator.hide(), 'panel', null, 'hidden', 'S10.08'],
      [() => s.coordinator.restore(), null, 'panel', 'panel', 'S10.09']
    ]
    for (const [act, from, to, state, id] of table) {
      const moved = act()
      bothDone(s, from, to)
      await moved
      expect(s.coordinator.ladder(), id).toEqual({ state, lastId: id })
    }

    s.coordinator.closed('quit')
    expect(s.coordinator.ladder()).toEqual({ state: 'tray-only', lastId: 'S10.15' })
    expect(shownWindows(s)).toEqual([])
    s.coordinator.hostClosed()
    expect(s.coordinator.ladder()).toEqual({ state: 'not-running', lastId: 'S10.16' })

    const crashing = setup({ start: 'panel' })
    crashing.coordinator.crashed()
    expect(crashing.coordinator.ladder()).toEqual({ state: 'not-running', lastId: 'S10.17' })

    // Not listed: a clean Host close while a window is shown (S10.16 is from tray-only only).
    const shown = setup({ start: 'panel' })
    expect(shown.coordinator.hostClosed()).toEqual({ ok: false, error: 'not-listed' })
    expect(shown.coordinator.ladder()).toEqual({ state: 'panel', lastId: null })
  })
})
