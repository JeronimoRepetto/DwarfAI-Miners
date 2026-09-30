import type {
  PanelLayout,
  PanelLayoutRequest,
  PanelWindowController
} from '../panelWindowController'

type Call = 'hide' | 'show' | 'toggleVisible' | 'setAlwaysOnTop' | 'layout' | 'setLayout'

/**
 * Hand-written double of `PanelWindowController` (16 §4.14, 16 §2.8): one Panel window with its
 * visibility, whether it is the frontmost window, its always-on-top state and its layout. Every
 * call is recorded in order, so a test can prove that nothing but the expected call happened.
 */
export class FakePanelWindowController implements PanelWindowController {
  readonly calls: Call[] = []
  visible: boolean
  frontmost: boolean
  alwaysOnTop = false
  private current: PanelLayout

  constructor(state: { visible: boolean; layout?: PanelLayout }) {
    this.visible = state.visible
    this.frontmost = false
    this.current = state.layout ?? { edge: 'right', mineOpen: false, dockOpen: false }
  }

  hide(): void {
    this.calls.push('hide')
    this.visible = false
    this.frontmost = false
  }

  show(): void {
    this.calls.push('show')
    this.visible = true
    this.frontmost = true
  }

  toggleVisible(): void {
    this.calls.push('toggleVisible')
    this.visible = !this.visible
    this.frontmost = this.visible
  }

  setAlwaysOnTop(on: boolean): boolean {
    this.calls.push('setAlwaysOnTop')
    this.alwaysOnTop = on
    return this.alwaysOnTop
  }

  layout(): PanelLayout {
    this.calls.push('layout')
    return { ...this.current }
  }

  setLayout(r: PanelLayoutRequest): PanelLayout {
    this.calls.push('setLayout')
    this.current = { edge: r.edge ?? this.current.edge, mineOpen: r.mineOpen, dockOpen: r.dockOpen }
    return { ...this.current }
  }

  /** The layout as it is, read without recording a call. */
  get currentLayout(): PanelLayout {
    return { ...this.current }
  }
}
