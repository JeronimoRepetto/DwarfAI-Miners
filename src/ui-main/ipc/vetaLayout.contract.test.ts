// layer: L6
import {
  CHANNELS,
  ROW_IDS,
  UNROUTED,
  type ChannelKey,
  type DwarfId,
  type MineId,
  type VetaLayoutRequest,
  type VetaLayoutResult
} from '@dwarfai/contracts'
import { describe, expect, it } from 'vitest'
import { createRouter } from './router'
import { ROUTES } from './routes'
import type { IpcSenderEvent, SenderPolicy } from './senderCheck'
import {
  createVetaLayoutRows,
  LAYOUT_VETA,
  VETA_DOCK_CHANGED,
  VETA_LAYOUT_ROWS
} from './vetaLayout'

/**
 * A-N23 `layoutVeta`, A-N28 `onVetaDockChanged` (14 §2.2, §3.9, §6.5; ADR-019 items 7, 8; ADR-025 items 2, 5): the
 * real router and seam A gate, with the routes this release's table gives the rows, in front of a dock double that
 * records the requests that reached it.
 */
const APP_ENTRY = 'file:///opt/DwarfAI/out/renderer/index.html'
const PANEL_ID = 7
const VETA_ID = 8
const MODE_WINDOWS = new Set([PANEL_ID, VETA_ID])
const senders: SenderPolicy = { appEntry: APP_ENTRY, isModeWindow: (id) => MODE_WINDOWS.has(id) }
const from = (id: number, url = `${APP_ENTRY}?mode=veta`): IpcSenderEvent => ({
  sender: { id },
  senderFrame: { url }
})

const PLACE: VetaLayoutResult = {
  applied: true,
  displayKey: 'Q27G2WG4|2560x1440|@1|0,0',
  dock: { edge: 'bottom', end: 'end', offset: 16 }
}

/** Every kind of 14 §3.9 `VetaLayoutRequest`, one valid request each. */
const EVERY_KIND: readonly VetaLayoutRequest[] = [
  {
    kind: 'rise',
    dwarfId: '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b' as DwarfId,
    chatBounds: { width: 420, height: 560 }
  },
  { kind: 'fold' },
  { kind: 'unfold-overflow', mineId: '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2c' as MineId },
  { kind: 'drag-start', screenX: 100, screenY: 1300 },
  { kind: 'drag-end', screenX: 2000, screenY: 5 },
  { kind: 'dock-key', edge: 'left' },
  { kind: 'island-resize', length: 520 },
  { kind: 'overlay', bounds: { width: 300, height: 200 } },
  { kind: 'overlay', bounds: null }
]

function world() {
  const reached: VetaLayoutRequest[] = []
  const router = createRouter({
    routes: ROUTES.filter((route) =>
      (VETA_LAYOUT_ROWS as readonly string[]).includes(route.channel)
    ),
    uiLocal: createVetaLayoutRows({
      dock: {
        layout: (request) => {
          reached.push(request)
          return PLACE
        },
        current: () => ({ displayKey: PLACE.displayKey, dock: PLACE.dock })
      },
      isVeta: (id) => id === VETA_ID
    }),
    senders
  })
  return { router, reached }
}

describe('the Veta layout rows over seam A (14 §2.2 A-N23, A-N28)', () => {
  it('[ADR-019] layoutVeta and onVetaDockChanged are declared once with strict schemas and every VetaLayoutRequest kind', () => {
    expect(Object.entries(ROW_IDS).filter(([, id]) => ['A-N23', 'A-N28'].includes(id))).toEqual([
      ['veta:layout', 'A-N23'],
      ['veta:dock:changed', 'A-N28']
    ])
    expect([CHANNELS[LAYOUT_VETA].kind, CHANNELS[LAYOUT_VETA].placement]).toEqual([
      'invoke',
      'ui-local'
    ])
    expect([CHANNELS[VETA_DOCK_CHANGED].kind, CHANNELS[VETA_DOCK_CHANGED].placement]).toEqual([
      'push',
      'ui-local'
    ])
    const request = CHANNELS[LAYOUT_VETA].request
    for (const kind of EVERY_KIND) expect(request.safeParse(kind).success, kind.kind).toBe(true)
    const result = CHANNELS[LAYOUT_VETA].response
    expect(result.safeParse(PLACE).success).toBe(true)
    expect(result.safeParse({ ...PLACE, dock: { ...PLACE.dock, edge: 'middle' } }).success).toBe(
      false
    )
    const changed = CHANNELS[VETA_DOCK_CHANGED].response
    for (const reason of ['display-removed', 'display-changed', 'work-area-changed']) {
      expect(
        changed.safeParse({ displayKey: PLACE.displayKey, dock: PLACE.dock, reason }).success
      ).toBe(true)
    }
    // UC-065 SQ-AR-03: a reset is never an A-N28 reason.
    expect(
      changed.safeParse({ displayKey: PLACE.displayKey, dock: PLACE.dock, reason: 'metrics-reset' })
        .success
    ).toBe(false)
  })

  it('[ADR-019] an unknown kind or an extra key is INVALID_PARAMS', async () => {
    const { router, reached } = world()
    const invalid: unknown[] = [
      { kind: 'teleport', screenX: 1, screenY: 1 },
      { kind: 'drag-end', screenX: 1, screenY: 1, displayKey: 'x' },
      { kind: 'dock-key', edge: 'middle' },
      { kind: 'island-resize', length: '520' },
      { kind: 'fold', extra: true },
      { kind: 'overlay', bounds: { width: 1, height: 1, x: 0 } },
      {}
    ]
    for (const payload of invalid) {
      expect(await router.dispatch(LAYOUT_VETA, from(VETA_ID), payload)).toMatchObject({
        ok: false,
        error: { code: 'INVALID_PARAMS' }
      })
    }
    expect(router.refusalCount(LAYOUT_VETA, 'INVALID_PARAMS')).toBe(invalid.length)
    expect(reached).toEqual([])
    // A valid request from the Veta window reaches the dock; from another mode window nothing is applied.
    expect(
      await router.dispatch(LAYOUT_VETA, from(VETA_ID), { kind: 'dock-key', edge: 'top' })
    ).toEqual(PLACE)
    expect(
      await router.dispatch(LAYOUT_VETA, from(PANEL_ID, APP_ENTRY), {
        kind: 'dock-key',
        edge: 'left'
      })
    ).toEqual({ ...PLACE, applied: false })
    expect(reached).toEqual([{ kind: 'dock-key', edge: 'top' }])
  })

  it('[ADR-001] A-N23 and A-N28 route ui-local', () => {
    for (const key of [LAYOUT_VETA, VETA_DOCK_CHANGED]) {
      expect(UNROUTED[key as ChannelKey], key).toBeUndefined()
      expect(
        ROUTES.filter((route) => route.channel === key).map((route) => [route.owner, route.shape]),
        key
      ).toEqual([['ui-local', 'target']])
    }
  })
})
