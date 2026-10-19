import type {
  DisplayKey,
  ModeWindow,
  PanelWindow,
  Rect,
  ValleWindow,
  VetaWindow,
  WindowFactory
} from '../windowFactory'

type ModeWindowCall =
  | { member: 'placeAt'; bounds: Rect }
  | { member: 'showInactive' }
  | { member: 'hide' }
  | { member: 'focus' }
  | { member: 'send'; push: string; payload: unknown }

/** One mode window of the fake: its state and every call it got, in order. */
export class FakeModeWindow implements ModeWindow {
  readonly calls: ModeWindowCall[] = []
  bounds: Rect | null = null
  visible = false
  focused = false

  placeAt(bounds: Rect): void {
    this.calls.push({ member: 'placeAt', bounds })
    this.bounds = bounds
  }

  showInactive(): void {
    this.calls.push({ member: 'showInactive' })
    this.visible = true
  }

  hide(): void {
    this.calls.push({ member: 'hide' })
    this.visible = false
    this.focused = false
  }

  focus(): void {
    this.calls.push({ member: 'focus' })
    this.focused = true
  }

  send(push: string, payload: unknown): void {
    this.calls.push({ member: 'send', push, payload })
  }

  /** The pushes this window was sent, in order. */
  get pushes(): { push: string; payload: unknown }[] {
    return this.calls.flatMap((call) =>
      call.member === 'send' ? [{ push: call.push, payload: call.payload }] : []
    )
  }
}

/**
 * Hand-written double of `WindowFactory` (16 §4.14, 16 §2.8). Like `ElectronWindows` it keeps one window per mode
 * window (one Panel, one Veta per display key, one Valle), so asking again returns the window already built; `built`
 * records each window it built, in order.
 */
export class FakeWindowFactory implements WindowFactory {
  readonly built: { kind: 'panel' | 'veta' | 'valle'; key?: DisplayKey }[] = []
  private panelWindow: FakeModeWindow | null = null
  private readonly vetaWindows = new Map<DisplayKey, FakeModeWindow>()
  private valleWindow: FakeModeWindow | null = null

  panel(): PanelWindow & FakeModeWindow {
    if (this.panelWindow === null) {
      this.panelWindow = new FakeModeWindow()
      this.built.push({ kind: 'panel' })
    }
    return this.panelWindow
  }

  veta(displayKey: DisplayKey): VetaWindow & FakeModeWindow {
    let window = this.vetaWindows.get(displayKey)
    if (window === undefined) {
      window = new FakeModeWindow()
      this.vetaWindows.set(displayKey, window)
      this.built.push({ kind: 'veta', key: displayKey })
    }
    return window
  }

  valle(from: DisplayKey): ValleWindow & FakeModeWindow {
    if (this.valleWindow === null) {
      this.valleWindow = new FakeModeWindow()
      this.built.push({ kind: 'valle', key: from })
    }
    return this.valleWindow
  }
}
