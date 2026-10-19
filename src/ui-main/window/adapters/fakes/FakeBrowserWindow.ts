import type { BrowserWindowConstructorOptions } from 'electron'
import type { Rect } from '../../ports/windowFactory'
import type { ManagedBrowserWindow, ManagedWebContents } from '../ElectronWindows'

type Listener = (...args: never[]) => void

/**
 * A stand-in for Electron's `BrowserWindow` (a real one cannot be built outside an Electron process): it keeps the
 * options it was built with, records what was asked of it and of its `webContents`, and fires the renderer events a
 * test needs (`render-process-gone`, `unresponsive`, `responsive`, `closed`). For the Panel surface (ISSUE-047) it also
 * keeps the state a window manager decides and the surface reads back: the bounds (held to `widest`), the pin (refused
 * while `honorsPin` is false), visibility and minimize; and it fires `minimize` and `restore`.
 */
export class FakeBrowserWindow implements ManagedBrowserWindow {
  static nextId = 1
  /** Every window built, in order. */
  static readonly built: FakeBrowserWindow[] = []

  readonly options: BrowserWindowConstructorOptions
  readonly calls: string[] = []
  readonly webContents: FakeWebContents
  private readonly listeners = new Map<string, Listener[]>()
  private destroyed = false
  /** The rectangle the window manager left: the one asked, held to `widest`. */
  private placed: Rect = { x: 0, y: 0, width: 0, height: 0 }
  widest = Infinity
  pinned: boolean
  honorsPin = true
  visible = false
  minimized = false

  constructor(options: BrowserWindowConstructorOptions) {
    this.options = options
    this.webContents = new FakeWebContents(FakeBrowserWindow.nextId++, this.calls)
    this.pinned = options.alwaysOnTop === true
    FakeBrowserWindow.built.push(this)
  }

  static reset(): void {
    FakeBrowserWindow.built.length = 0
  }

  setBounds(bounds: Rect): void {
    this.calls.push(`setBounds ${bounds.width}x${bounds.height}@${bounds.x},${bounds.y}`)
    this.placed = { ...bounds, width: Math.min(bounds.width, this.widest) }
  }

  getBounds(): Rect {
    return { ...this.placed }
  }

  setAlwaysOnTop(flag: boolean): void {
    this.calls.push(`setAlwaysOnTop ${flag}`)
    if (this.honorsPin) this.pinned = flag
  }

  isAlwaysOnTop(): boolean {
    return this.pinned
  }

  isVisible(): boolean {
    return this.visible
  }

  isMinimized(): boolean {
    return this.minimized
  }

  restore(): void {
    this.calls.push('restore')
    this.minimized = false
  }

  show(): void {
    this.calls.push('show')
    this.visible = true
  }

  moveTop(): void {
    this.calls.push('moveTop')
  }

  showInactive(): void {
    this.calls.push('showInactive')
    this.visible = true
  }

  hide(): void {
    this.calls.push('hide')
    this.visible = false
  }

  focus(): void {
    this.calls.push('focus')
  }

  close(): void {
    this.calls.push('close')
    this.destroyed = true
    for (const listener of this.listeners.get('closed') ?? []) (listener as () => void)()
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  once(event: 'closed', listener: () => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
    return this
  }

  on(event: 'minimize' | 'restore', listener: () => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
    return this
  }

  /** Fires a window event as Electron would. */
  emit(event: 'minimize' | 'restore'): void {
    for (const listener of this.listeners.get(event) ?? []) (listener as () => void)()
  }
}

type ZoomMode = 'default' | 'isolated' | 'manual' | 'disabled'

export class FakeWebContents implements ManagedWebContents {
  private readonly listeners = new Map<string, Listener[]>()
  zoom = 1
  zoomMode: ZoomMode = 'default'

  constructor(
    readonly id: number,
    private readonly calls: string[]
  ) {}

  loadURL(url: string): Promise<void> {
    this.calls.push(`loadURL ${url}`)
    return Promise.resolve()
  }

  send(channel: string, payload: unknown): void {
    this.calls.push(`send ${channel} ${JSON.stringify(payload)}`)
  }

  setZoomFactor(factor: number): void {
    this.calls.push(`setZoomFactor ${factor}`)
    this.zoom = factor
  }

  getZoomFactor(): number {
    return this.zoom
  }

  getZoomMode(): ZoomMode {
    return this.zoomMode
  }

  setZoomMode(mode: ZoomMode): void {
    this.zoomMode = mode
  }

  forcefullyCrashRenderer(): void {
    this.calls.push('forcefullyCrashRenderer')
    this.emit('render-process-gone', {}, { reason: 'killed', exitCode: 1 })
  }

  on(event: string, listener: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
    return this
  }

  /** Fires a renderer event as Electron would. */
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      ;(listener as (...a: unknown[]) => void)(...args)
    }
  }

  /** The renderer process went away for `reason`. */
  crash(reason = 'crashed'): void {
    this.emit('render-process-gone', {}, { reason, exitCode: 1 })
  }
}
