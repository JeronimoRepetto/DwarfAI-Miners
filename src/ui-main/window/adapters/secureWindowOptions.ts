import type { BrowserWindowConstructorOptions, WebPreferences } from 'electron'

/**
 * The one window factory of the app (ADR-019 item 1; 18 C-01). Every `BrowserWindow` (the Panel today, Veta and Valle
 * later, ADR-025) is built here and nowhere else: the lint rule "no `new BrowserWindow(` outside secureWindowOptions"
 * (eslint.config.mjs, ADR-019 Verification) keeps it so.
 *
 * The renderer is untrusted (NFR-SEC-08): it runs sandboxed, in its own JavaScript world, without Node, without
 * webviews, and it can neither flood dialogs nor navigate by a drop. `sandbox: true` is set explicitly although
 * Electron 44 sandboxes by default (S-019-1 finding 3): the explicit flag is the decision, the default is not. A
 * sandboxed preload must be one CommonJS file whose only runtime import is `electron` (S-019-1 decision).
 */
const SECURE_WEB_PREFERENCES = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  webviewTag: false,
  safeDialogs: true,
  navigateOnDragDrop: false,
  // Interim `false` (option (a) of ADR-019 item 1) until the design ruling on the composer spellcheck and spike
  // S-019-3: it makes no network call (NFR-SEC-11).
  spellcheck: false
} as const satisfies WebPreferences

/** What a window kind asks of the factory. Its web preferences are the factory's, never the caller's. */
export interface SecureWindowRequest {
  /** The preload script: one CommonJS file (S-019-1). */
  readonly preload: string
  /** The window-level options of this window kind (frame, size, visibility, …). */
  readonly window?: Omit<BrowserWindowConstructorOptions, 'webPreferences'>
  /** The one page-level switch a window kind may set: the Panel starts its music without a gesture (#174). */
  readonly autoplayPolicy?: WebPreferences['autoplayPolicy']
}

/**
 * The constructor options of a window. The security preferences are written last, so nothing a caller passes (not
 * even a `webPreferences` slipped past the type) can weaken them.
 */
export function secureWindowOptions(request: SecureWindowRequest): BrowserWindowConstructorOptions {
  const window: BrowserWindowConstructorOptions = { ...request.window }
  delete window.webPreferences
  return {
    ...window,
    webPreferences: {
      preload: request.preload,
      ...(request.autoplayPolicy === undefined ? {} : { autoplayPolicy: request.autoplayPolicy }),
      ...SECURE_WEB_PREFERENCES
    }
  }
}

/** Electron's `BrowserWindow` class, passed in so the factory is testable without an Electron process. */
export type BrowserWindowClass<W> = new (options: BrowserWindowConstructorOptions) => W

/** Builds a window from exactly `secureWindowOptions(request)`: the only `new BrowserWindow(` of the app. */
export function createSecureWindow<W>(
  BrowserWindow: BrowserWindowClass<W>,
  request: SecureWindowRequest
): W {
  return new BrowserWindow(secureWindowOptions(request))
}
