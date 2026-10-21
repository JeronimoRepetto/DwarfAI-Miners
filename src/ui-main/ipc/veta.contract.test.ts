// layer: L6
import { CHANNELS, ROW_IDS, UNROUTED, type ChannelKey } from '@dwarfai/contracts'
import { describe, expect, it } from 'vitest'
import { createRouter } from './router'
import { ROUTES } from './routes'
import type { IpcSenderEvent, SenderPolicy } from './senderCheck'
import { createVetaRows, GET_WINDOWING_LIMITS, SET_VETA_CLICK_THROUGH, VETA_ROWS } from './veta'

/**
 * A-N22 `setVetaClickThrough`, A-N24 `getWindowingLimits` (14 §2.2, §6.5; ADR-019 items 7, 8; ADR-025 items 4, 6):
 * the real router and seam A gate, with the routes this release's table gives the rows, in front of a Veta window
 * double that records what reached it.
 */
const APP_ENTRY = 'file:///opt/DwarfAI/out/renderer/index.html'
const PANEL_ID = 7
const VETA_ID = 8
const STRANGER_ID = 99
const MODE_WINDOWS = new Set([PANEL_ID, VETA_ID])
const senders: SenderPolicy = { appEntry: APP_ENTRY, isModeWindow: (id) => MODE_WINDOWS.has(id) }
const from = (id: number, url = `${APP_ENTRY}?mode=veta`): IpcSenderEvent => ({
  sender: { id },
  senderFrame: { url }
})
const KEYS = ['veta:clickThrough', 'window:limits'] as const

function world() {
  const toggles: boolean[] = []
  const router = createRouter({
    routes: ROUTES.filter((route) => (VETA_ROWS as readonly string[]).includes(route.channel)),
    uiLocal: createVetaRows({
      veta: { setClickThrough: (ignore) => toggles.push(ignore) },
      isVeta: (id) => id === VETA_ID,
      limits: () => ({ dockingAvailable: false, alwaysOnTopAvailable: true })
    }),
    senders
  })
  return { router, toggles }
}

describe('the Veta rows over seam A (14 §2.2 A-N22, A-N24)', () => {
  it('[ADR-019] setVetaClickThrough and getWindowingLimits are declared once with strict schemas', () => {
    const ids = Object.entries(ROW_IDS).filter(([, id]) => ['A-N22', 'A-N24'].includes(id))
    expect(ids).toEqual([
      ['veta:clickThrough', 'A-N22'],
      ['window:limits', 'A-N24']
    ])
    expect(KEYS.map((key) => [CHANNELS[key].kind, CHANNELS[key].placement])).toEqual([
      ['send', 'ui-local'],
      ['invoke', 'ui-local']
    ])
    const clickThrough = CHANNELS['veta:clickThrough'].request
    expect(clickThrough.safeParse({ ignore: true }).success).toBe(true)
    expect(clickThrough.safeParse({ ignore: 'yes' }).success).toBe(false)
    expect(clickThrough.safeParse({}).success).toBe(false)
    const limits = CHANNELS['window:limits'].response
    expect(limits.safeParse({ dockingAvailable: true, alwaysOnTopAvailable: false }).success).toBe(
      true
    )
    expect(
      limits.safeParse({ dockingAvailable: true, alwaysOnTopAvailable: false, session: 'x11' })
        .success
    ).toBe(false)
  })

  it('[ADR-019] a setVetaClickThrough payload with an extra key is refused and changes nothing', async () => {
    const { router, toggles } = world()
    expect(
      await router.dispatch(SET_VETA_CLICK_THROUGH, from(VETA_ID), { ignore: true, x: 1 })
    ).toBeUndefined()
    expect(router.refusalCount(SET_VETA_CLICK_THROUGH, 'INVALID_PARAMS')).toBe(1)
    expect(toggles).toEqual([])
    // Only the Veta window toggles its own click-through; a frame that is not a mode window never reaches it.
    await router.dispatch(SET_VETA_CLICK_THROUGH, from(PANEL_ID, APP_ENTRY), { ignore: true })
    await router.dispatch(SET_VETA_CLICK_THROUGH, from(STRANGER_ID), { ignore: true })
    expect(toggles).toEqual([])
    await router.dispatch(SET_VETA_CLICK_THROUGH, from(VETA_ID), { ignore: true })
    expect(toggles).toEqual([true])
    // A-N24 answers any mode window (Settings › General reads it in the Panel) with the limits as they are.
    expect(
      await router.dispatch(GET_WINDOWING_LIMITS, from(PANEL_ID, APP_ENTRY), undefined)
    ).toEqual({ dockingAvailable: false, alwaysOnTopAvailable: true })
  })

  it('[ADR-001] A-N22 and A-N24 route ui-local', () => {
    for (const key of KEYS) {
      expect(UNROUTED[key as ChannelKey], key).toBeUndefined()
      expect(
        ROUTES.filter((route) => route.channel === key).map((route) => [route.owner, route.shape]),
        key
      ).toEqual([['ui-local', 'target']])
    }
  })
})
