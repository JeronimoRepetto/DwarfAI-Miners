import type { BrowserWindowConstructorOptions } from 'electron'
import { describe, expect, it } from 'vitest'
import { createSecureWindow, secureWindowOptions } from './secureWindowOptions'

const PRELOAD = '/app/out/preload/index.cjs'

describe('secureWindowOptions (ADR-019 item 1; 18 C-01)', () => {
  it('[ADR-019] the factory sets sandbox, context isolation, no node integration, no webview tag, safe dialogs, no navigate on drop and spellcheck off', () => {
    expect(secureWindowOptions({ preload: PRELOAD })).toEqual({
      webPreferences: {
        preload: PRELOAD,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        webviewTag: false,
        safeDialogs: true,
        navigateOnDragDrop: false,
        // Interim value until the design ruling on the composer spellcheck (ADR-019 item 1, S-019-3).
        spellcheck: false
      }
    })
  })

  it('[ADR-019] a window kind keeps its own window options and cannot override a security preference', () => {
    const hostile = {
      preload: PRELOAD,
      window: {
        show: false,
        frame: false,
        // Not allowed by the type; a cast stands in for a caller that slips one in anyway.
        webPreferences: { sandbox: false, contextIsolation: false, nodeIntegration: true }
      } as unknown as Omit<BrowserWindowConstructorOptions, 'webPreferences'>,
      autoplayPolicy: 'no-user-gesture-required' as const
    }
    const options = secureWindowOptions(hostile)
    expect(options.show).toBe(false)
    expect(options.frame).toBe(false)
    expect(options.webPreferences).toEqual({
      preload: PRELOAD,
      autoplayPolicy: 'no-user-gesture-required',
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
      safeDialogs: true,
      navigateOnDragDrop: false,
      spellcheck: false
    })
  })

  it('[ADR-019] createSecureWindow builds the window from exactly the factory options', () => {
    const built: BrowserWindowConstructorOptions[] = []
    class RecordingBrowserWindow {
      constructor(options: BrowserWindowConstructorOptions) {
        built.push(options)
      }
    }
    const request = { preload: PRELOAD, window: { show: false } }
    const window = createSecureWindow(RecordingBrowserWindow, request)
    expect(window).toBeInstanceOf(RecordingBrowserWindow)
    expect(built).toEqual([secureWindowOptions(request)])
  })
})
