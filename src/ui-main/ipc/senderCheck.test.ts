// layer: L1
import { describe, expect, it } from 'vitest'
import { createModeWindowRegistry } from '../window/application/modeWindowRegistry'
import { isAllowedSender, type IpcSenderEvent, type SenderPolicy } from './senderCheck'

/**
 * The seam A sender check (ADR-019 item 8; 14 §1.4; 18 C-07): an event is accepted only when its `webContents` is a
 * window the window module registered as a mode window and its `senderFrame` URL is the app's own entry.
 */
describe('sender check (ADR-019 item 8)', () => {
  const PACKAGED_ENTRY = 'file:///opt/DwarfAI/resources/app.asar/out/renderer/index.html'
  const DEV_ENTRY = 'http://localhost:5173'

  function policyWith(appEntry: string, ...modeWindows: number[]) {
    const registry = createModeWindowRegistry()
    for (const id of modeWindows) registry.register(id)
    const policy: SenderPolicy = { appEntry, isModeWindow: (id) => registry.has(id) }
    return { registry, policy }
  }

  const eventFrom = (id: number, url: string | null): IpcSenderEvent => ({
    sender: { id },
    senderFrame: url === null ? null : { url }
  })

  it('[ADR-019] an event from the app entry of a known mode window is accepted', () => {
    const packaged = policyWith(PACKAGED_ENTRY, 7)
    expect(isAllowedSender(eventFrom(7, PACKAGED_ENTRY), packaged.policy)).toBe(true)
    // A fragment or a query never names another document: the page is still the app entry.
    expect(isAllowedSender(eventFrom(7, `${PACKAGED_ENTRY}#chat`), packaged.policy)).toBe(true)
    expect(isAllowedSender(eventFrom(7, `${PACKAGED_ENTRY}?mode=panel`), packaged.policy)).toBe(
      true
    )

    // The dev server entry is loaded without a path; the frame reports it with its root path.
    const dev = policyWith(DEV_ENTRY, 3, 4)
    expect(isAllowedSender(eventFrom(3, 'http://localhost:5173/'), dev.policy)).toBe(true)
    expect(isAllowedSender(eventFrom(4, 'http://localhost:5173/'), dev.policy)).toBe(true)
  })

  it('[ADR-019] an event from an unknown webContents or a foreign frame URL is ignored', () => {
    const { registry, policy } = policyWith(PACKAGED_ENTRY, 7)

    // The right page in a window that is not a registered mode window.
    expect(isAllowedSender(eventFrom(8, PACKAGED_ENTRY), policy)).toBe(false)
    // A registered mode window whose frame is not the app entry.
    for (const url of [
      'https://attacker.example/',
      'file:///opt/DwarfAI/resources/app.asar/out/renderer/other.html',
      'file:///tmp/out/renderer/index.html',
      'http://localhost:5173/',
      'about:blank',
      'not a url',
      ''
    ]) {
      expect(isAllowedSender(eventFrom(7, url), policy), url).toBe(false)
    }
    // A frame that is gone (null) or whose URL cannot be read any more (Electron throws on a disposed frame).
    expect(isAllowedSender(eventFrom(7, null), policy)).toBe(false)
    const disposed: IpcSenderEvent = {
      sender: { id: 7 },
      get senderFrame(): { url: string } {
        throw new Error('Render frame was disposed before WebFrameMain could be accessed')
      }
    }
    expect(isAllowedSender(disposed, policy)).toBe(false)
    // A mode window that closed is no longer known.
    registry.drop(7)
    expect(isAllowedSender(eventFrom(7, PACKAGED_ENTRY), policy)).toBe(false)

    // The dev server entry does not admit another port or another origin.
    const dev = policyWith(DEV_ENTRY, 3)
    for (const url of [
      'http://localhost:5174/',
      'http://127.0.0.1:5173/',
      'https://localhost:5173/'
    ]) {
      expect(isAllowedSender(eventFrom(3, url), dev.policy), url).toBe(false)
    }
  })
})
