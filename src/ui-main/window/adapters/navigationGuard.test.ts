import { describe, expect, it } from 'vitest'
import {
  guardWebContents,
  installNavigationGuard,
  isAppEntry,
  type GuardableWebContents
} from './navigationGuard'

const PACKAGED_ENTRY = 'file:///opt/dwarfai/resources/app.asar/out/renderer/index.html'
const DEV_ENTRY = 'http://localhost:5173'

type Listener = (event: { url: string; preventDefault(): void }) => void

/** A `webContents` stand-in: the guard's listeners, the window-open handler, and a way to fire each event. */
class FakeWebContents implements GuardableWebContents {
  private readonly listeners = new Map<string, Listener[]>()
  windowOpenHandler: ((details: { url: string }) => { action: 'deny' | 'allow' }) | null = null

  on(event: string, listener: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
    return this
  }

  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void {
    this.windowOpenHandler = handler
  }

  /** Fires `event` for `url` and answers whether a listener prevented it. */
  fire(event: string, url = ''): boolean {
    let prevented = false
    const payload = {
      url,
      preventDefault: () => {
        prevented = true
      }
    }
    for (const listener of this.listeners.get(event) ?? []) listener(payload)
    return prevented
  }

  openWindow(url: string): { action: 'deny' | 'allow' } {
    if (this.windowOpenHandler === null) throw new Error('no window-open handler installed')
    return this.windowOpenHandler({ url })
  }
}

function guarded(appEntry = PACKAGED_ENTRY) {
  const opened: string[] = []
  const contents = new FakeWebContents()
  guardWebContents(contents, { appEntry, openExternal: (url) => opened.push(url) })
  return { contents, opened }
}

describe('navigation guard (ADR-019 item 2; 18 C-02)', () => {
  it('[ADR-019] javascript:, file:, data:, ms-settings: and a 2049-character URL never reach openExternal', () => {
    const { contents, opened } = guarded()
    const hostile = [
      'javascript:alert(1)',
      'file:///C:/Windows/System32/calc.exe',
      'data:text/html,<script>alert(1)</script>',
      'ms-settings:privacy',
      `https://example.test/${'a'.repeat(2049 - 'https://example.test/'.length)}`
    ]
    expect(hostile[4]).toHaveLength(2049)
    for (const url of hostile) {
      expect(contents.openWindow(url), url).toEqual({ action: 'deny' })
    }
    expect(opened).toEqual([])
  })

  it('[ADR-019] an allowlisted https link opens in the browser and never in a new window', () => {
    const { contents, opened } = guarded()
    expect(contents.openWindow('https://example.test/docs?q=1')).toEqual({ action: 'deny' })
    expect(opened).toEqual(['https://example.test/docs?q=1'])
  })

  it('[ADR-019] will-navigate and will-redirect off the app entry are prevented and will-attach-webview is denied', () => {
    const { contents } = guarded()
    for (const url of [
      'https://example.test/',
      'file:///etc/passwd',
      'file:///opt/dwarfai/resources/app.asar/out/renderer/other.html',
      'javascript:alert(1)',
      'not a url'
    ]) {
      expect(contents.fire('will-navigate', url), `will-navigate ${url}`).toBe(true)
      expect(contents.fire('will-redirect', url), `will-redirect ${url}`).toBe(true)
    }
    expect(contents.fire('will-attach-webview')).toBe(true)
  })

  it('[ADR-019] a navigation that stays on the app entry is let through', () => {
    const packaged = guarded(PACKAGED_ENTRY).contents
    expect(packaged.fire('will-navigate', `${PACKAGED_ENTRY}#/settings`)).toBe(false)
    expect(packaged.fire('will-redirect', `${PACKAGED_ENTRY}?reload=1`)).toBe(false)
    const dev = guarded(DEV_ENTRY).contents
    expect(dev.fire('will-navigate', 'http://localhost:5173/')).toBe(false)
    expect(dev.fire('will-navigate', 'http://localhost:5174/')).toBe(true)
  })

  it('[ADR-019] the app-wide guard covers every webContents Electron creates', () => {
    let created: ((event: unknown, contents: GuardableWebContents) => void) | null = null
    const opened: string[] = []
    installNavigationGuard(
      {
        on: (_event, listener) => {
          created = listener
        }
      },
      { appEntry: PACKAGED_ENTRY, openExternal: (url) => opened.push(url) }
    )
    const contents = new FakeWebContents()
    expect(created).not.toBeNull()
    created!({}, contents)
    expect(contents.fire('will-navigate', 'https://example.test/')).toBe(true)
    expect(contents.openWindow('file:///etc/passwd')).toEqual({ action: 'deny' })
    expect(opened).toEqual([])
  })

  it('[ADR-019] the app entry is the packaged document or the dev-server origin, nothing else', () => {
    expect(isAppEntry(PACKAGED_ENTRY, PACKAGED_ENTRY)).toBe(true)
    expect(isAppEntry(PACKAGED_ENTRY, 'file:///opt/dwarfai/other/index.html')).toBe(false)
    expect(isAppEntry(DEV_ENTRY, 'http://localhost:5173/src/main.ts')).toBe(true)
    expect(isAppEntry(DEV_ENTRY, 'https://localhost:5173/')).toBe(false)
    expect(isAppEntry('not a url', 'not a url')).toBe(false)
  })
})
