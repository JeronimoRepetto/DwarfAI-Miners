import type { BrowserWindowConstructorOptions } from 'electron'
import type { Rect } from '../../ports/windowFactory'
import type { ManagedBrowserWindow, ManagedWebContents } from '../ElectronWindows'

type Listener = (...args: never[]) => void

/**
 * A stand-in for Electron's `BrowserWindow` (a real one cannot be built outside an Electron process): it keeps the
 * options it was built with, records what was asked of it and of its `webContents`, and fires the renderer events a
 * test needs (`render-process-gone`, `unresponsive`, `responsive`, `closed`).
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

  constructor(options: BrowserWindowConstructorOptions) {
    this.options = options
    this.webContents = new FakeWebContents(FakeBrowserWindow.nextId++, this.calls)
    FakeBrowserWindow.built.push(this)
  }

  static reset(): void {
    FakeBrowserWindow.built.length = 0
  }

  setBounds(bounds: Rect): void {
    this.calls.push(`setBounds ${bounds.width}x${bounds.height}@${bounds.x},${bounds.y}`)
  }

  showInactive(): void {
    this.calls.push('showInactive')
  }

  hide(): void {
    this.calls.push('hide')
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
}

export class FakeWebContents implements ManagedWebContents {
  private readonly listeners = new Map<string, Listener[]>()

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
