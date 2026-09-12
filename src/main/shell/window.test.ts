import type { BrowserWindow } from 'electron'
import { describe, expect, it } from 'vitest'
import { emptyMessagePanel } from './messagePanelState'
import { DESIGN_SCREEN_HEIGHT, RAIL_WIDTH, uiScale } from './panelBounds'
import {
  // ADDED for #389 — the deferred hide that lets a closing surface settle.
  MESSAGE_PANEL_LEAVE_TIMEOUT_MS,
  MESSAGE_PANEL_REVEAL_TIMEOUT_MS,
  messagePanelHideIsDue,
  type MessagePanelHideTarget,
  applyAlwaysOnTop,
  buildMessagePanelWindowOptions,
  applyPanelBounds,
  applyUiScale,
  buildMainWindowOptions,
  formatShellTrace,
  messagePanelNeedsReveal,
  messagePanelState,
  panelLayout,
  raisePanelWindow,
  seedPanelEdge,
  setMessagePanel,
  setPanelLayout,
  shellDebugEnabled,
  type AlwaysOnTopTarget,
  type MessagePanelRevealTarget,
  type PanelBoundsTarget,
  type RaiseTarget,
  type UiScaleTarget
} from './window'

/**
 * The rail the redesigned shell opens as (#90) — a rectangle main derived from
 * the display before the window existed, which this file only has to carry
 * through untouched.
 */
const RAIL_BOUNDS = { x: 1900, y: 0, width: RAIL_WIDTH, height: 1032 }

/**
 * The message panel beside it (#162) — a rectangle main derived from the
 * display and from where the shell actually is, which this file, again, only
 * carries through untouched.
 */
const MESSAGE_PANEL_BOUNDS = { x: 8, y: 797, width: 990, height: 235 }

/**
 * Deterministic BrowserWindow stand-in for the always-on-top surface: it
 * records every set call and can be told to refuse the change, the way a
 * window manager that ignores the hint would (some Linux compositors do).
 */
function fakeWindow(options: { honorsChanges?: boolean; initial?: boolean } = {}) {
  let real = options.initial ?? false
  const calls: boolean[] = []
  const target: AlwaysOnTopTarget = {
    setAlwaysOnTop: (flag) => {
      calls.push(flag)
      if (options.honorsChanges !== false) real = flag
    },
    isAlwaysOnTop: () => real
  }
  return { target, calls }
}

describe('applyAlwaysOnTop', () => {
  it('applies the request and reports the state read back from the window', () => {
    const { target, calls } = fakeWindow()
    expect(applyAlwaysOnTop(target, true)).toBe(true)
    expect(applyAlwaysOnTop(target, false)).toBe(false)
    expect(calls).toEqual([true, false])
  })

  it('reports the REAL state, never the wish, when the platform refuses the change', () => {
    const { target } = fakeWindow({ honorsChanges: false, initial: false })
    expect(applyAlwaysOnTop(target, true)).toBe(false)
  })
})

/**
 * The shell as a 1080-designed surface scaled onto the display (#153).
 *
 * Same read-back rule as the pin and the bounds: Electron forwards the request
 * and the answer is what the page ACTUALLY got, because a zoom the renderer
 * refused would leave main computing a window for a surface that is not there.
 */
function fakeZoomTarget(options: { honorsChanges?: boolean; roundsTrip?: boolean } = {}) {
  let real = 1
  const calls: number[] = []
  const target: UiScaleTarget = {
    setZoomFactor: (factor) => {
      calls.push(factor)
      if (options.honorsChanges !== false) real = factor
    },
    /*
     * AMENDED for #388 (was: `() => real`). Chromium stores zoom as a
     * logarithmic LEVEL and answers with `1.2 ** level`, so the factor a page
     * reports is the one that was set give or take the last bit. `roundsTrip`
     * is a page that does exactly that, which is what any real one does.
     */
    getZoomFactor: () =>
      options.roundsTrip === true ? Math.pow(1.2, Math.log(real) / Math.log(1.2)) : real
  }
  /** The zoom Electron drops on every navigation, without recording a call. */
  const lose = (): void => {
    real = 1
  }
  return { target, calls, lose }
}

describe('applyUiScale', () => {
  it('zooms the page by the display’s own height against the design world', () => {
    const { target, calls } = fakeZoomTarget()
    const area = { x: 0, y: 0, width: 3840, height: 2160 }
    expect(applyUiScale(target, area)).toBe(2)
    expect(calls).toEqual([2])
  })

  it('leaves a display that IS the design world at 1, so nothing is resampled', () => {
    const { target } = fakeZoomTarget()
    expect(applyUiScale(target, { x: 0, y: 0, width: 1920, height: DESIGN_SCREEN_HEIGHT })).toBe(1)
  })

  it('applies the same continuous factor the window’s own width is derived from', () => {
    const { target, calls } = fakeZoomTarget()
    const twoK = { x: 0, y: 0, width: 2560, height: 1392 }
    applyUiScale(target, twoK)
    // The panel's physical width and the renderer's zoom have to come from one
    // number: if they ever disagree the columns main reserved stop matching the
    // columns the renderer draws, which is invisible until something clips.
    expect(calls).toEqual([uiScale(twoK)])
  })

  it('reports the REAL factor, never the wish, when the page refuses it', () => {
    const { target } = fakeZoomTarget({ honorsChanges: false })
    expect(applyUiScale(target, { x: 0, y: 0, width: 3840, height: 2160 })).toBe(1)
  })

  /*
   * ADDED for #388. `setPanelLayout` re-applies the scale on every layout
   * change, because a layout change can carry the window onto another display —
   * and most of them do not. Whether an unchanged `setZoomFactor` costs the
   * renderer a relayout is UNMEASURED here; not asking it in the frame the
   * shell's fold is running in costs nothing either way.
   */
  it('leaves a page that already has the factor alone', () => {
    const { target, calls } = fakeZoomTarget()
    const area = { x: 0, y: 0, width: 3840, height: 2160 }
    applyUiScale(target, area)
    applyUiScale(target, area)
    expect(calls).toEqual([2])
  })

  it('reads a factor the page rounded through its zoom level as the same factor', () => {
    const { target, calls } = fakeZoomTarget({ roundsTrip: true })
    const twoK = { x: 0, y: 0, width: 2560, height: 1392 }
    applyUiScale(target, twoK)
    applyUiScale(target, twoK)
    expect(calls).toEqual([uiScale(twoK)])
  })

  it('gives the factor back to a page that lost it, which every navigation does', () => {
    const { target, calls, lose } = fakeZoomTarget()
    const area = { x: 0, y: 0, width: 3840, height: 2160 }
    applyUiScale(target, area)
    lose()
    expect(applyUiScale(target, area)).toBe(2)
    expect(calls).toEqual([2, 2])
  })
})

describe('buildMainWindowOptions', () => {
  const input = {
    alwaysOnTop: true,
    preloadPath: 'C:/app/out/preload/index.mjs',
    iconPath: 'C:/app/resources/app-icon.png',
    bounds: RAIL_BOUNDS
  }

  it('applies the stored pin preference at creation', () => {
    expect(buildMainWindowOptions({ ...input, alwaysOnTop: true }).alwaysOnTop).toBe(true)
    expect(buildMainWindowOptions({ ...input, alwaysOnTop: false }).alwaysOnTop).toBe(false)
  })

  it('keeps the frameless floating-panel invariants regardless of the pin preference', () => {
    const options = buildMainWindowOptions({ ...input, alwaysOnTop: false })
    expect(options.frame).toBe(false)
    expect(options.transparent).toBe(true)
    expect(options.skipTaskbar).toBe(true)
    expect(options.show).toBe(false)
  })

  it('wires the preload and icon paths through untouched', () => {
    const options = buildMainWindowOptions(input)
    expect(options.webPreferences?.preload).toBe(input.preloadPath)
    expect(options.icon).toBe(input.iconPath)
  })

  it('keeps the renderer sandboxed from Node and isolated from the preload world', () => {
    const options = buildMainWindowOptions(input)
    expect(options.webPreferences?.contextIsolation).toBe(true)
    expect(options.webPreferences?.nodeIntegration).toBe(false)
  })

  /*
   * The music has to start on its own (#174), and Chromium's autoplay policy
   * will not let it: a page that has had no user gesture cannot start audio,
   * and this window is created hidden and shown by a global shortcut or the
   * tray — neither of which is a gesture ON the page. The documented switch is
   * this one, and it is stated here so a future edit cannot drop it and leave
   * a silent launch that only shows up by ear.
   */
  it('lets the renderer start audio without a user gesture, which #174 needs', () => {
    expect(buildMainWindowOptions(input).webPreferences?.autoplayPolicy).toBe(
      'no-user-gesture-required'
    )
  })
})

/*
 * Issue #44 gave the free-floating panel a `minWidth`/`minHeight` floor, because
 * 460x600 was only ever a STARTING size on a resizable window and a user could
 * drag the cave below the smallest box its anchors were authored in.
 *
 * The redesigned shell (#90) is DOCKED: main derives its rectangle from the
 * display and from whether the panel is open, so there is no size to drag and a
 * 20px rail cannot coexist with a 276px floor. These three tests kept their
 * subject — the window Electron is asked to create — and changed what they
 * assert about it.
 *
 * REMOVED with them, stated here rather than passing unseen: the assertions
 * holding `minWidth`/`minHeight` to `MIN_PANEL_SIZE` and `width`/`height` to
 * `AUTHORED_PANEL_SIZE`, and this file's import of both from
 * `renderer/src/lib/scene/sceneSizing`. The guarantee they enforced — the cave
 * is never drawn below the box it was authored in — did not go with them: it
 * moved to `panelBounds.test.ts`, which holds the MINE COLUMN to
 * `MIN_PANEL_SIZE.width` and the copied scene chrome to `PANEL_CHROME.width`,
 * because that column is where the cave now lives.
 */
describe('buildMainWindowOptions docked bounds', () => {
  const input = {
    alwaysOnTop: true,
    preloadPath: 'C:/app/out/preload/index.mjs',
    iconPath: 'C:/app/resources/app-icon.png',
    bounds: RAIL_BOUNDS
  }

  it('gives the docked panel no size for a user to drag', () => {
    const options = buildMainWindowOptions(input)
    expect(options.resizable).toBe(false)
    // A floor would fight the rail rather than protect anything: the rail is
    // 20px wide on purpose, and main is the only thing that sets these bounds.
    expect(options.minWidth).toBeUndefined()
    expect(options.minHeight).toBeUndefined()
  })

  it('opens exactly on the rail rectangle it was handed', () => {
    const options = buildMainWindowOptions(input)
    expect(options.x).toBe(RAIL_BOUNDS.x)
    expect(options.y).toBe(RAIL_BOUNDS.y)
    expect(options.width).toBe(RAIL_WIDTH)
    expect(options.height).toBe(RAIL_BOUNDS.height)
  })

  it('never adjusts those bounds for the pin preference', () => {
    // Every shape the pin preference can put the builder in still lands on the
    // same rectangle: where the panel hangs is a property of the display, not
    // of the user's pin choice.
    for (const alwaysOnTop of [true, false]) {
      const options = buildMainWindowOptions({ ...input, alwaysOnTop })
      expect({ x: options.x, y: options.y, width: options.width, height: options.height }).toEqual(
        RAIL_BOUNDS
      )
    }
  })
})

/**
 * Moving the docked panel between the rail and the open panel (#90).
 *
 * The read-back is the point, exactly as it is for the pin: Electron forwards a
 * bounds request and a compositor may place the window somewhere else — a
 * tiling window manager will simply ignore it — so the renderer has to be told
 * what the window became, never what was asked for.
 */
describe('applyPanelBounds', () => {
  function fakeBoundsWindow(options: { honorsChanges?: boolean } = {}) {
    let real = { x: 0, y: 0, width: 0, height: 0 }
    const calls: { x: number; y: number; width: number; height: number }[] = []
    const target: PanelBoundsTarget = {
      setBounds: (bounds) => {
        calls.push(bounds)
        if (options.honorsChanges !== false) real = bounds
      },
      getBounds: () => real
    }
    return { target, calls }
  }

  it('applies the rectangle and reports what the window read back', () => {
    const { target, calls } = fakeBoundsWindow()
    expect(applyPanelBounds(target, RAIL_BOUNDS)).toEqual(RAIL_BOUNDS)
    expect(calls).toEqual([RAIL_BOUNDS])
  })

  it('reports the REAL rectangle, never the wish, when the window manager refuses', () => {
    const { target } = fakeBoundsWindow({ honorsChanges: false })
    expect(applyPanelBounds(target, RAIL_BOUNDS)).toEqual({ x: 0, y: 0, width: 0, height: 0 })
  })
})

/**
 * The Settings position control (#138): the docked side is now settable, and
 * it persists. No real BrowserWindow exists in either test here (`mainWindow`
 * stays null at module scope until createMainWindow() runs), so setPanelLayout
 * only has to prove what it computes — applyPanelBounds against a live window
 * is already covered above.
 */
describe('panel layout edge (#138)', () => {
  it('seeds the persisted edge before any window exists, for the very first frame', () => {
    seedPanelEdge('left')
    expect(panelLayout().edge).toBe('left')
    seedPanelEdge('right')
    expect(panelLayout().edge).toBe('right')
  })

  it('keeps the current edge when a request does not name one', () => {
    // The rail toggle and the mine-open resize both send bare
    // expanded/mineOpen requests; neither is the position control, and
    // neither may nudge the docked side by accident.
    seedPanelEdge('left')
    expect(setPanelLayout({ expanded: true, mineOpen: false }).edge).toBe('left')
    expect(setPanelLayout({ expanded: false, mineOpen: false }).edge).toBe('left')
  })

  it('moves to the requested edge when the position control asks for one', () => {
    seedPanelEdge('right')
    const result = setPanelLayout({ expanded: true, mineOpen: false, edge: 'left' })
    expect(result.edge).toBe('left')
    expect(panelLayout().edge).toBe('left')
  })

  it('carries expanded and mineOpen through unchanged alongside an edge move', () => {
    seedPanelEdge('right')
    const result = setPanelLayout({ expanded: true, mineOpen: true, edge: 'left' })
    expect(result).toEqual({ edge: 'left', expanded: true, mineOpen: true })
  })
})

/**
 * The third acceptance run's sixth correction (#165).
 *
 * With another program focused, clicking DwarfAI-Miners left the window BEHIND
 * it — alive, visible, receiving the click, and never raised. The shell is a
 * frameless TRANSPARENT window (a layered window on Windows), which is the one
 * combination the platform's own click-to-front does not reliably apply, and
 * nothing in the app compensated: the only focus() in the whole process was
 * showPanel's.
 *
 * The rule the maintainer set is simple enough to test as one: a click anywhere
 * on the shell raises AND focuses it, pinned or not. So the renderer reports the
 * click and this is what main does with it.
 */
describe('raisePanelWindow', () => {
  function fakeRaiseTarget(state: { visible?: boolean; minimized?: boolean } = {}) {
    const calls: string[] = []
    const target: RaiseTarget = {
      isVisible: () => state.visible ?? true,
      isMinimized: () => state.minimized ?? false,
      restore: () => calls.push('restore'),
      show: () => calls.push('show'),
      moveTop: () => calls.push('moveTop'),
      focus: () => calls.push('focus')
    }
    return { target, calls }
  }

  it('raises the window above the stack and then focuses it', () => {
    // moveTop before focus, because the two are different asks: one is z-order
    // and the other is keyboard focus, and a window focused underneath another
    // is exactly the state the maintainer photographed.
    const { target, calls } = fakeRaiseTarget()
    raisePanelWindow(target)
    expect(calls).toEqual(['moveTop', 'focus'])
  })

  it('raises a window the user minimized rather than leaving it in the taskbar', () => {
    const { target, calls } = fakeRaiseTarget({ minimized: true })
    raisePanelWindow(target)
    expect(calls).toEqual(['restore', 'moveTop', 'focus'])
  })

  it('never shows a window that is deliberately hidden', () => {
    // Hidden is the tray state, and the click that reaches this cannot have
    // landed on a window nobody can see. Showing one would make a stray call
    // from the renderer into a way to reopen the panel behind the user's back.
    const { target, calls } = fakeRaiseTarget({ visible: false })
    raisePanelWindow(target)
    expect(calls).toEqual([])
  })
})

describe('the shell window can be focused at all', () => {
  it('is focusable, stated rather than left to the default (#165)', () => {
    // The one flag that would silently undo the raise above: a window Electron
    // was told not to focus cannot be focused by anything, click included.
    const options = buildMainWindowOptions({
      alwaysOnTop: false,
      preloadPath: 'C:/app/out/preload/index.mjs',
      iconPath: 'C:/app/resources/app-icon.png',
      bounds: RAIL_BOUNDS
    })
    expect(options.focusable).toBe(true)
  })
})
/**
 * The message panel as a window of its own (#162).
 *
 * The design draws it as a second surface beside the shell, so it is a second
 * BrowserWindow — and every question that raises is about how it relates to the
 * shell rather than about what it contains. Same discipline as the block above:
 * no real BrowserWindow exists here, so the builder is asserted on its own and
 * the state is asserted on what it stores.
 */
describe('buildMessagePanelWindowOptions', () => {
  /** Stands in for the shell window, which is all the parent slot is. */
  const shell = {} as unknown as BrowserWindow

  const input = {
    alwaysOnTop: true,
    preloadPath: 'C:/app/out/preload/index.mjs',
    iconPath: 'C:/app/resources/app-icon.png',
    bounds: MESSAGE_PANEL_BOUNDS,
    parent: shell
  }

  it('opens hidden, on the rectangle it was handed', () => {
    const options = buildMessagePanelWindowOptions(input)
    // Hidden because nothing has measured the panel yet: the renderer reports
    // its own height and that first report is what reveals the window.
    expect(options.show).toBe(false)
    expect({
      x: options.x,
      y: options.y,
      width: options.width,
      height: options.height
    }).toEqual(MESSAGE_PANEL_BOUNDS)
  })

  it('is the same frameless floating surface the shell is', () => {
    const options = buildMessagePanelWindowOptions(input)
    expect(options.frame).toBe(false)
    expect(options.transparent).toBe(true)
    expect(options.focusable).toBe(true)
  })

  it('is a CHILD of the shell, so it cannot outlive it', () => {
    // Closing the shell closes this window, and it never becomes a second
    // entry in the taskbar or Alt-Tab beside the app it belongs to.
    expect(buildMessagePanelWindowOptions(input).parent).toBe(shell)
    expect(buildMessagePanelWindowOptions(input).skipTaskbar).toBe(true)
  })

  it('mirrors the shell’s pin rather than owning a second one', () => {
    // Pinning is the shell's control and the tray's business (#35). A panel
    // that floated while the shell did not — or the other way round — would
    // split one window's stacking into two answers.
    expect(buildMessagePanelWindowOptions({ ...input, alwaysOnTop: true }).alwaysOnTop).toBe(true)
    expect(buildMessagePanelWindowOptions({ ...input, alwaysOnTop: false }).alwaysOnTop).toBe(false)
  })

  it('gives the panel no size for a user to drag, because main owns its rectangle', () => {
    // The design's vertical-only resize is the panel's own top-edge handle: it
    // reports a height and main applies it, so the window's width can never be
    // dragged away from the 990 the composition is derived from.
    const options = buildMessagePanelWindowOptions(input)
    expect(options.resizable).toBe(false)
    expect(options.minWidth).toBeUndefined()
    expect(options.minHeight).toBeUndefined()
  })

  it('wires the SAME preload, so the panel reads one typed API', () => {
    const options = buildMessagePanelWindowOptions(input)
    expect(options.webPreferences?.preload).toBe(input.preloadPath)
    expect(options.icon).toBe(input.iconPath)
  })

  it('keeps the second renderer sandboxed from Node and isolated from the preload world', () => {
    const options = buildMessagePanelWindowOptions(input)
    expect(options.webPreferences?.contextIsolation).toBe(true)
    expect(options.webPreferences?.nodeIntegration).toBe(false)
  })
})

/**
 * The state both windows write and both read (#162).
 *
 * The shell opens the panel on a dwarf or on the mine's Add action; the panel
 * window closes itself, and adopts the dwarf a launch produced. Main is the one
 * serialization point, so the answer is always what it STORED — the same
 * read-back rule `setPanelLayout` above follows.
 */
describe('setMessagePanel', () => {
  it('answers with what it stored, and stores what it answered', () => {
    const opened = setMessagePanel({
      surface: 'message',
      mineId: 'mine:a',
      dwarfId: 'claude:s1'
    })
    expect(opened).toEqual({ surface: 'message', mineId: 'mine:a', dwarfId: 'claude:s1' })
    expect(messagePanelState()).toEqual(opened)
  })

  it('takes the launch surface, which names a mine and no dwarf yet', () => {
    const launching = setMessagePanel({ surface: 'launch', mineId: 'mine:a', dwarfId: '' })
    expect(launching).toEqual({ surface: 'launch', mineId: 'mine:a', dwarfId: '' })
  })

  it('closes back to nothing, which is the window hidden rather than destroyed', () => {
    setMessagePanel({ surface: 'message', mineId: 'mine:a', dwarfId: 'claude:s1' })
    expect(setMessagePanel(emptyMessagePanel())).toEqual(emptyMessagePanel())
    expect(messagePanelState()).toEqual(emptyMessagePanel())
  })

  it('hands out a copy, so a reader cannot change what main holds', () => {
    setMessagePanel({ surface: 'message', mineId: 'mine:a', dwarfId: 'claude:s1' })
    const read = messagePanelState()
    read.dwarfId = 'claude:someone-else'
    expect(messagePanelState().dwarfId).toBe('claude:s1')
  })
})

/**
 * The window opens even when its renderer never measured anything (#312).
 *
 * The first open of a run created the window and stopped there: the height
 * report that is the ONE thing which reveals it never arrived, and main had no
 * second answer — so a click produced a halo on the dwarf and no panel, and
 * only closing and reopening got one. A report is still what sizes the window;
 * this is what keeps a silent renderer from costing the click entirely.
 *
 * Asserted through a narrow target with a fake, the way `raisePanelWindow` and
 * the three `apply*` above are: the wait itself happens inside Electron and
 * cannot be reached from here, but every rule about whether to reveal can.
 */
describe('revealing a panel window nothing measured', () => {
  function fakeRevealTarget(state: { visible?: boolean; destroyed?: boolean } = {}) {
    const target: MessagePanelRevealTarget = {
      isDestroyed: () => state.destroyed ?? false,
      isVisible: () => state.visible ?? false
    }
    return target
  }

  it('reveals a window that is still hidden on a surface that is still open', () => {
    expect(messagePanelNeedsReveal(fakeRevealTarget(), 'message')).toBe(true)
    expect(messagePanelNeedsReveal(fakeRevealTarget(), 'launch')).toBe(true)
  })

  it('leaves a window a height report already revealed alone', () => {
    // The ordinary run: the report landed inside the wait, sized the window
    // and showed it. Showing it again would be a raise nobody asked for.
    expect(messagePanelNeedsReveal(fakeRevealTarget({ visible: true }), 'message')).toBe(false)
  })

  it('never opens a window onto a surface that closed while it waited', () => {
    // A second click can deselect before the wait is out, and main's state is
    // then 'none' — the panel would come back showing the dwarf nobody has
    // selected any more.
    expect(messagePanelNeedsReveal(fakeRevealTarget(), 'none')).toBe(false)
  })

  it('has nothing to reveal once the window has been destroyed', () => {
    expect(messagePanelNeedsReveal(fakeRevealTarget({ destroyed: true }), 'message')).toBe(false)
  })

  it('waits longer than a page load and less than a person reads as a failure', () => {
    // The bound is the requirement, not the number: long enough that the
    // ordinary report wins the race and this never fires, short enough that
    // what the person sees is the panel opening rather than a click that did
    // nothing and a panel arriving later.
    expect(MESSAGE_PANEL_REVEAL_TIMEOUT_MS).toBeGreaterThanOrEqual(500)
    expect(MESSAGE_PANEL_REVEAL_TIMEOUT_MS).toBeLessThanOrEqual(2000)
  })
})

/**
 * ADDED for #389. The window stays up while its surface settles.
 *
 * The mirror image of the block above, and asserted the same way and for the
 * same reason: the wait itself happens inside Electron and cannot be reached
 * from here, but every rule about whether the hide is owed can. A close used to
 * take the window off screen in the frame the state changed, which left the
 * renderer nothing to animate — so main defers, and the renderer's report is
 * what ends the deferral early.
 */
describe('hiding a panel window once its surface has settled', () => {
  function fakeHideTarget(state: { visible?: boolean; destroyed?: boolean } = {}) {
    const target: MessagePanelHideTarget = {
      isDestroyed: () => state.destroyed ?? false,
      isVisible: () => state.visible ?? true
    }
    return target
  }

  it('hides a visible window whose closed surface reported itself settled', () => {
    expect(messagePanelHideIsDue(fakeHideTarget(), 'none', true)).toBe(true)
  })

  it('ignores a report nothing was waiting for', () => {
    // A leave overtaken by a reopen, or a renderer reporting twice: main
    // cancels the wait when a surface opens, so an unarmed report is one whose
    // close has already been answered — and hiding on it would close a panel
    // by way of a message about an older one.
    expect(messagePanelHideIsDue(fakeHideTarget(), 'none', false)).toBe(false)
  })

  it('never hides a window whose surface opened again while the old one settled', () => {
    expect(messagePanelHideIsDue(fakeHideTarget(), 'message', true)).toBe(false)
    expect(messagePanelHideIsDue(fakeHideTarget(), 'launch', true)).toBe(false)
  })

  it('has nothing to hide when the window is gone, or was never shown', () => {
    expect(messagePanelHideIsDue(fakeHideTarget({ destroyed: true }), 'none', true)).toBe(false)
    expect(messagePanelHideIsDue(fakeHideTarget({ visible: false }), 'none', true)).toBe(false)
  })

  it('waits out the renderer’s own bounded leave, and no longer', () => {
    // The bound is the requirement, not the number. It has to outlast the
    // renderer's watchdog — 250ms of motion plus a margin — so an honest leave
    // always reports before main stops listening; and it has to stay short
    // enough that a renderer which reports nothing at all still leaves the
    // window gone rather than standing transparent over other programs.
    expect(MESSAGE_PANEL_LEAVE_TIMEOUT_MS).toBeGreaterThan(300)
    expect(MESSAGE_PANEL_LEAVE_TIMEOUT_MS).toBeLessThanOrEqual(600)
  })
})

/**
 * The switch that makes a first message-panel open say what it did (#312).
 *
 * The first open of a run took a path nobody could see: the panel window is
 * created hidden and revealed by a height report, and every refusal on the way
 * there is a bare `return`. A whole failing run produced not one line from
 * main, which is why the flag exists at all — and why it is asserted here
 * rather than trusted, exactly as its three siblings are.
 */
describe('shellDebugEnabled', () => {
  it('is off when nobody asked for it', () => {
    expect(shellDebugEnabled({})).toBe(false)
  })

  it('is on for the two affirmative spellings, in any case', () => {
    for (const raw of ['1', 'true', 'TRUE', 'True']) {
      expect(shellDebugEnabled({ SHELL_DEBUG: raw })).toBe(true)
    }
  })

  it('stays off for anything else, so a stray value cannot switch it on', () => {
    // The same refusal DWARFAI_PERF, TIER_DEBUG and CODEX_DEBUG make: an empty
    // string, a '0' or a word is not a request, and a debugging device that
    // turns itself on for one is one nobody can turn off.
    for (const raw of ['', '0', 'false', 'yes', 'on']) {
      expect(shellDebugEnabled({ SHELL_DEBUG: raw })).toBe(false)
    }
  })
})

/**
 * One diagnostic line, and the shape the maintainer pastes back (#312).
 *
 * Pure and asserted for the reason every other decision in this file is: the
 * moments it describes all happen inside Electron, so the only part that can be
 * proven without a display is what the line SAYS — and a line missing the one
 * fact that separates a first open from a second one is a line that costs a
 * whole reproduction.
 */
describe('formatShellTrace', () => {
  it('names the subject, the moment, and every fact after it', () => {
    expect(formatShellTrace('message panel placed', { surface: 'message', visible: false })).toBe(
      '[shell] message panel placed: surface=message visible=false'
    )
  })

  it('states a moment with nothing to add without a dangling colon', () => {
    expect(formatShellTrace('message panel window close', {})).toBe(
      '[shell] message panel window close'
    )
  })

  it('folds a rectangle into one field, so the line stays greppable', () => {
    // Size before origin, and no spaces inside the value: a rectangle split
    // across fields cannot be compared between two lines at a glance, and one
    // carrying a space stops being one field.
    expect(formatShellTrace('message panel window created', { bounds: MESSAGE_PANEL_BOUNDS })).toBe(
      '[shell] message panel window created: bounds=990x235@8,797'
    )
  })

  it('carries an anchor as the two numbers it actually is, not as a rectangle', () => {
    // A remembered position is an x and a BOTTOM edge (see MessagePanelAnchor):
    // printing it as a rectangle would invent a width and a height nothing
    // stored, and this line is read beside the bounds the anchor produced.
    expect(
      formatShellTrace('message panel window created', { anchor: { x: 300, bottom: 900 } })
    ).toBe('[shell] message panel window created: anchor=300,900')
  })

  it('says "none" for a fact that is absent, never nothing at all', () => {
    // A missing anchor is the answer to the first question this flag was added
    // to settle, so it has to be printed rather than left off the line.
    expect(formatShellTrace('message panel window created', { anchor: null })).toBe(
      '[shell] message panel window created: anchor=none'
    )
  })

  it('keeps the facts in the order they were written', () => {
    // Two lines from one run are read side by side, so the columns have to line
    // up: an object's own insertion order is the only order there is.
    expect(formatShellTrace('m', { a: 1, b: 2, c: 3 })).toBe('[shell] m: a=1 b=2 c=3')
  })
})
