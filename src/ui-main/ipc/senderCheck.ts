// The seam A sender check (ADR-019 item 8; 14 §1.4; 18 C-07). Pure.

/** The part of Electron's `IpcMainEvent` / `IpcMainInvokeEvent` the sender check reads. */
export interface IpcSenderEvent {
  readonly sender: { readonly id: number }
  readonly senderFrame: { readonly url: string } | null
}

export interface SenderPolicy {
  /** The app's own entry: the dev server URL in development, the packaged `index.html` file URL otherwise. */
  readonly appEntry: string
  /** Whether a `webContents` id belongs to a window the window module registered as a mode window. */
  isModeWindow(webContentsId: number): boolean
}

/**
 * The document a URL names: scheme, host (with port) and path. A fragment or a query stays inside the same document,
 * so it never turns a foreign page into the app entry nor the app entry into a foreign page. `undefined` for a
 * string that is not an absolute URL.
 */
function documentOf(url: string): string | undefined {
  if (!URL.canParse(url)) return undefined
  const { protocol, host, pathname } = new URL(url)
  return `${protocol}//${host}${pathname}`
}

/**
 * Allowed iff the event's `webContents` is a registered mode window and its `senderFrame` URL is the app's own entry.
 * A frame that is gone, or that Electron can no longer read, is not allowed. Never throws.
 */
export function isAllowedSender(event: IpcSenderEvent, policy: SenderPolicy): boolean {
  try {
    if (!policy.isModeWindow(event.sender.id)) return false
    const frame = event.senderFrame
    if (frame === null) return false
    const entry = documentOf(policy.appEntry)
    return entry !== undefined && documentOf(frame.url) === entry
  } catch {
    return false
  }
}
