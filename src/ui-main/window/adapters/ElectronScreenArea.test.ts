import type { screen } from 'electron'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { DESIGN_SCREEN_HEIGHT, panelBounds, panelWidth } from '../domain/panelBounds'
import { runScreenAreaProviderContract } from '../ports/screenAreaProvider.contract'
import {
  currentUiPlatform,
  displayKeyOf,
  ElectronScreenArea,
  minWindowWidth,
  panelScreenArea,
  type DisplayAreas,
  type ElectronDisplay,
  type ElectronScreen,
  type UiPlatform
} from './ElectronScreenArea'

/** A stand-in for Electron's `screen`: the displays a test hands it, and the display events it fires. */
class FakeElectronScreen implements ElectronScreen {
  readonly listeners = new Map<string, Array<() => void>>()
  constructor(
    public all: ElectronDisplay[],
    public primaryId: number
  ) {}
  getAllDisplays(): ElectronDisplay[] {
    return this.all
  }
  getPrimaryDisplay(): ElectronDisplay {
    const primary = this.all.find((d) => d.id === this.primaryId)
    if (primary === undefined) throw new Error('no primary display')
    return primary
  }
  on(event: string, listener: () => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
    return this
  }
  emit(event: string): void {
    for (const listener of this.listeners.get(event) ?? []) listener()
  }
}

const LAPTOP: ElectronDisplay = {
  id: 7,
  label: 'Built-in Display',
  bounds: { x: 0, y: 0, width: 1536, height: 864 },
  workArea: { x: 0, y: 0, width: 1536, height: 824 },
  size: { width: 1536, height: 864 },
  scaleFactor: 1.25
}
const MONITOR: ElectronDisplay = {
  id: 2_779_098_405,
  label: '',
  bounds: { x: 1536, y: -200, width: 2560, height: 1440 },
  workArea: { x: 1536, y: -200, width: 2560, height: 1400 },
  size: { width: 2560, height: 1440 },
  scaleFactor: 1
}

runScreenAreaProviderContract(
  'ElectronScreenArea',
  () => new ElectronScreenArea(() => new FakeElectronScreen([LAPTOP, MONITOR], LAPTOP.id), 'win32')
)

describe('ElectronScreenArea (05 §3.14; ADR-024 D5)', () => {
  it('[INV-118] the display key comes from stable display facts, never display.id alone', () => {
    // The same display after a reboot may carry another id: its key does not change.
    expect(displayKeyOf({ ...MONITOR, id: 1 }, LAPTOP)).toBe(displayKeyOf(MONITOR, LAPTOP))
    // Its label, native resolution, scale factor and place relative to the primary display are the key.
    const keys = new Set([
      displayKeyOf(MONITOR, LAPTOP),
      displayKeyOf({ ...MONITOR, label: 'DELL U2720Q' }, LAPTOP),
      displayKeyOf({ ...MONITOR, scaleFactor: 1.5 }, LAPTOP),
      displayKeyOf({ ...MONITOR, size: { width: 1920, height: 1080 } }, LAPTOP),
      displayKeyOf({ ...MONITOR, bounds: { ...MONITOR.bounds, x: -2560 } }, LAPTOP)
    ])
    expect(keys.size).toBe(5)
    expect(displayKeyOf(MONITOR, LAPTOP)).not.toContain(String(MONITOR.id))
  })

  it('[FM-111] a display plugged in or out, or a changed work area or scale, is reported', () => {
    const fake = new FakeElectronScreen([LAPTOP], LAPTOP.id)
    const area = new ElectronScreenArea(() => fake, 'linux')
    let changes = 0
    area.onChange(() => changes++)
    fake.emit('display-added')
    fake.emit('display-removed')
    fake.emit('display-metrics-changed')
    expect(changes).toBe(3)
  })

  it('[ADR-024] the work area of a display is what the Panel may span, read when asked', () => {
    const fake = new FakeElectronScreen([LAPTOP, MONITOR], LAPTOP.id)
    const area = new ElectronScreenArea(() => fake, 'darwin')
    const monitor = area.displays().find((d) => !d.primary)!
    expect(area.workArea(monitor.displayKey)).toEqual(MONITOR.workArea)
    expect(area.minWindowWidth()).toBe(20)
    // The taskbar moved: the same key answers the new work area.
    fake.all = [LAPTOP, { ...MONITOR, workArea: { ...MONITOR.workArea, height: 1380 } }]
    expect(area.workArea(monitor.displayKey).height).toBe(1380)
  })

  it('[NFR-PLAT-01] the platform is one of the three the app runs on, named by this adapter alone', () => {
    expect(currentUiPlatform('win32')).toBe('win32')
    expect(currentUiPlatform('darwin')).toBe('darwin')
    expect(currentUiPlatform('linux')).toBe('linux')
    expect(currentUiPlatform('freebsd')).toBe('linux')
  })

  it('[ADR-019] Electron’s screen fits the adapter (checked by the typecheck)', () => {
    expectTypeOf<typeof screen>().toMatchTypeOf<ElectronScreen>()
  })
})

/*
 * TRANSPLANTED for ISSUE-047 from src/main/platform/screenArea.test.ts and windowMetrics.test.ts (16 §4.14:
 * `ElectronScreenArea` ← `platform/screenArea.ts`, `windowMetrics.ts`), and two cases from
 * src/main/shell/panelBounds.test.ts whose subject is the per-platform floor. Run unchanged first (17 §2.5), the legacy
 * files cannot load here: their subject is the legacy module (R16). Each case keeps its title and expectation; the
 * import paths changed, `Platform` is this adapter's `UiPlatform` (the same three names), and the two panelBounds cases
 * pass the floor `minWindowWidth(platform)` where they passed the platform. The legacy files are untouched; they
 * leave with ISSUE-058.
 */

/**
 * A display with a reserved strip along the bottom — a Windows taskbar, or the
 * macOS Dock — so the two rectangles differ and a test can tell which one the
 * rule picked.
 */
const DISPLAY: DisplayAreas = {
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1032 }
}

/**
 * A display reserved on BOTH edges the way a real Mac is: a slim menu-bar
 * strip along the top and the Dock along the bottom, so `workArea` moves both
 * `y` and `height` relative to `bounds` rather than just `height` the way the
 * Windows taskbar fixture above does. A fix that only special-cased height
 * would still fail this one.
 */
const TOP_AND_BOTTOM_RESERVED: DisplayAreas = {
  bounds: { x: 0, y: 0, width: 2560, height: 1440 },
  workArea: { x: 0, y: 25, width: 2560, height: 1291 }
}

/**
 * A display reserved on the LEFT edge — a Dock (or a taskbar) docked to the
 * side rather than the bottom, so `workArea.x` moves inward while `bounds.x`
 * stays at the display's own origin.
 */
const LEFT_DOCKED: DisplayAreas = {
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 70, y: 0, width: 1850, height: 1080 }
}

describe('panelScreenArea', () => {
  it('leaves the Windows taskbar visible', () => {
    expect(panelScreenArea(DISPLAY, 'win32')).toEqual(DISPLAY.workArea)
  })

  it.each<UiPlatform>(['darwin', 'linux'])(
    'leaves the reserved strip visible on %s too, not just Windows (#238)',
    (platform) => {
      // Until #238 this asserted the OPPOSITE: that macOS and Linux got the
      // whole display, following what the design's source said twice. That
      // was never checked on a real Mac — the Dock sits exactly in the strip
      // `workArea` reserves, and a real Mac showed the panel's own bottom
      // controls (Add panel, Message panel) landing behind it. `workArea` is
      // the right default on every platform, not a Windows-only carve-out.
      expect(panelScreenArea(DISPLAY, platform)).toEqual(DISPLAY.workArea)
    }
  )

  it.each<UiPlatform>(['darwin', 'linux'])(
    'reserves a top-and-bottom strip on %s the same way a real Mac does (#238)',
    (platform) => {
      expect(panelScreenArea(TOP_AND_BOTTOM_RESERVED, platform)).toEqual(
        TOP_AND_BOTTOM_RESERVED.workArea
      )
    }
  )

  it.each<UiPlatform>(['darwin', 'linux'])(
    'reserves a left-docked strip on %s too, not just a bottom one',
    (platform) => {
      expect(panelScreenArea(LEFT_DOCKED, platform)).toEqual(LEFT_DOCKED.workArea)
    }
  )

  it('carries the display origin through, so a secondary monitor still works', () => {
    const secondary: DisplayAreas = {
      bounds: { x: -1920, y: 120, width: 1920, height: 1080 },
      workArea: { x: -1920, y: 120, width: 1920, height: 1032 }
    }
    expect(panelScreenArea(secondary, 'win32').x).toBe(-1920)
    expect(panelScreenArea(secondary, 'darwin').y).toBe(120)
  })

  it('returns the rectangle unchanged when nothing is reserved', () => {
    const full: DisplayAreas = {
      bounds: { x: 0, y: 0, width: 1366, height: 768 },
      workArea: { x: 0, y: 0, width: 1366, height: 768 }
    }
    expect(panelScreenArea(full, 'win32')).toEqual(full.bounds)
  })
})

describe('minWindowWidth', () => {
  it('keeps the measured Windows floor (#153)', () => {
    // 32 is a measurement, not a guess: a BrowserWindow asked for 20px comes
    // back 32px wide on Windows.
    expect(minWindowWidth('win32')).toBe(32)
  })

  it.each<UiPlatform>(['darwin', 'linux'])(
    'asks %s for no more than the 20px it was always asked for, because no floor was ever measured there (#465)',
    (platform) => {
      // A floor wider than anything the window is asked to be is what leaves a
      // transparent gutter macOS then draws its shadow around (#465), and 20
      // is below every composition the Panel has.
      expect(minWindowWidth(platform)).toBe(20)
      expect(minWindowWidth(platform)).toBeLessThan(minWindowWidth('win32'))
    }
  )

  it('answers every supported platform with a whole number of pixels', () => {
    // Electron bounds take nothing else, and this number reaches them as a
    // window width through panelBounds.ts.
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      expect(Number.isInteger(minWindowWidth(platform))).toBe(true)
      expect(minWindowWidth(platform)).toBeGreaterThan(0)
    }
  })
})

describe('the per-platform floor in the Panel bounds', () => {
  const AT_1X = { x: 0, y: 0, width: 1920, height: DESIGN_SCREEN_HEIGHT }
  const OPEN = { mineOpen: false, dockOpen: false }
  const OPEN_WITH_MINE = { mineOpen: true, dockOpen: false }
  const OPEN_WITH_DOCK = { mineOpen: false, dockOpen: true }
  const OPEN_WITH_BOTH = { mineOpen: true, dockOpen: true }

  it('composes the same design width on every platform', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      // AMENDED for #635 (was: the mine-only composition as the third): every one there is now.
      for (const layout of [OPEN, OPEN_WITH_MINE, OPEN_WITH_DOCK, OPEN_WITH_BOTH]) {
        expect(panelWidth(AT_1X, layout, minWindowWidth(platform))).toBe(
          panelWidth(AT_1X, layout, minWindowWidth('win32'))
        )
      }
    }
  })

  /*
   * Windows refuses to make a window narrower than 32px — measured on the
   * maintainer's machine, where a 20px rail came back 32px wide. The floor is
   * requested here so both edges get the same window.
   */
  it('never asks for a window narrower than the platform will make', () => {
    // AMENDED for #465: asserted for each platform's own floor rather than for
    // the Windows one everywhere, which is the untruth that issue removes.
    // AMENDED for #635: the closed rail was the one composition narrower than
    // the floor, and it is gone, so the floor is asserted on a display whose
    // scale shrinks the whole Panel below it.
    const tiny = { x: 0, y: 0, width: 1920, height: 20 }
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      for (const edge of ['left', 'right'] as const) {
        const bounds = panelBounds(tiny, edge, OPEN, minWindowWidth(platform))
        expect(bounds.width).toBeGreaterThanOrEqual(minWindowWidth(platform))
      }
    }
  })
})
