// layer: L6
import { describe, expect, it } from 'vitest'
import { CHANNELS, todayShapeOf } from '@dwarfai/contracts'
import { createModeWindowRegistry } from '../../window/application/modeWindowRegistry'
import { createToggleShortcut } from '../../window/application/toggleShortcut'
import { FakeGlobalShortcutRegistry } from '../../window/ports/fakes/FakeGlobalShortcutRegistry'
import { FakePanelWindowController } from '../../window/ports/fakes/FakePanelWindowController'
import type { ChannelRoute } from '../channelRoute'
import { createRouter, type RouteTarget } from '../router'
import { ROUTES } from '../routes'
import type { IpcSenderEvent } from '../senderCheck'
import { createShortcutRows } from './shortcut'

/**
 * A-10 `getToggleShortcut` and A-11 `setToggleShortcut` served `ui-local` (14 §2.1, KEEP; ADR-024 item 9), through
 * the router and its seam A gate (`validateCall`, ISSUE-044). The table here is today's with only the two shortcut
 * rows `ui-local`, as the cut-0 switch (ISSUE-056) will make them; `routes.ts` itself is not changed.
 */

const APP_ENTRY = 'file:///opt/DwarfAI/resources/app.asar/out/renderer/index.html'
const PANEL = 7
const FROM_PANEL: IpcSenderEvent = { sender: { id: PANEL }, senderFrame: { url: APP_ENTRY } }
const OWNED_ELSEWHERE = 'Control+Alt+Shift+F9'
const FREE = 'Control+Shift+D'

function shortcutServedUiLocal(taken: string[]) {
  const registry = new FakeGlobalShortcutRegistry(taken)
  let stored = OWNED_ELSEWHERE
  const toggle = createToggleShortcut({
    registry,
    preference: { load: () => stored, save: (accel) => (stored = accel) },
    panel: new FakePanelWindowController({ visible: true }),
    platform: 'darwin'
  })
  toggle.start()

  const rows = createShortcutRows(toggle)
  const uiLocal: RouteTarget = {
    serve: async (channel, payload) => {
      if (channel === 'shortcut:get') return rows['shortcut:get']()
      if (channel === 'shortcut:set') return rows['shortcut:set'](payload as string)
      throw new Error(`not a shortcut row: ${channel}`)
    }
  }
  const shortcutRows = ['shortcut:get', 'shortcut:set']
  const routes: ChannelRoute[] = ROUTES.map((route) =>
    shortcutRows.includes(route.channel)
      ? { ...route, owner: 'ui-local', since: 'cut-0', parity: 'n/a' }
      : route
  )
  const modeWindows = createModeWindowRegistry()
  modeWindows.register(PANEL)
  const legacyServed: string[] = []
  const router = createRouter({
    routes,
    legacy: { serve: async (channel) => legacyServed.push(channel) },
    uiLocal,
    senders: { appEntry: APP_ENTRY, isModeWindow: (id) => modeWindows.has(id) }
  })
  return { router, registry, legacyServed, stored: () => stored }
}

const todayResponse = todayShapeOf('shortcut:get')?.response

describe('A-10 / A-11 ui-local (14 §2.1)', () => {
  it("[NFR-OBS-05] A-10 and A-11 keep today's ShortcutState shape and answer the real registration state", async () => {
    const { router, registry, legacyServed, stored } = shortcutServedUiLocal([OWNED_ELSEWHERE])

    const atStart = await router.dispatch('shortcut:get', FROM_PANEL, undefined)
    expect(atStart).toEqual({
      accelerator: OWNED_ELSEWHERE,
      registered: false,
      platform: 'darwin',
      error:
        'Ctrl + Option + Shift + F9 is already in use by another application. The panel can still be opened from the tray icon.'
    })

    const afterSet = await router.dispatch('shortcut:set', FROM_PANEL, FREE)
    expect(afterSet).toEqual({ accelerator: FREE, registered: true, platform: 'darwin' })
    expect(await router.dispatch('shortcut:get', FROM_PANEL, undefined)).toEqual(afterSet)
    expect(registry.heldAccelerators).toEqual([FREE])
    expect(stored()).toBe(FREE)

    // A payload that is not a string never reaches the setter: the gate answers the unchanged state (ISSUE-044).
    const refused = await router.dispatch('shortcut:set', FROM_PANEL, { accelerator: 'Alt+Q' })
    expect(refused).toEqual(afterSet)
    expect(registry.registerCalls).toEqual([OWNED_ELSEWHERE, FREE])

    // An invalid accelerator answers the legacy failure shape: the state with its `error` (14 §1.5).
    const invalid = await router.dispatch('shortcut:set', FROM_PANEL, 'P')
    expect(invalid).toMatchObject({ accelerator: FREE, registered: true })
    expect(typeof (invalid as { error?: unknown }).error).toBe('string')

    for (const answer of [atStart, afterSet, refused, invalid]) {
      expect(CHANNELS['shortcut:get'].response.safeParse(answer).success).toBe(true)
      expect(todayResponse?.safeParse(answer).success).toBe(true)
    }
    expect(legacyServed).toEqual([])
  })
})
