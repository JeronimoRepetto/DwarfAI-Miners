import type {
  ModeTransition,
  UiPreferenceKey,
  UiPreferencesMap,
  VetaDock,
  VetaDockChanged,
  VetaLayoutRequest,
  VetaLayoutResult
} from '@dwarfai/contracts'
import { describe, expect, it } from 'vitest'
import { createFakeWindowApi } from '../../../contracts/ipc/testing/fakeWindowApi'
import { useVetaDock } from './useVetaDock'

/**
 * The Veta renderer's dock (07 machine 21; 14 §2.2 A-N23, A-N28, A-N12, A-N20): the generated fake `window.api` stands
 * in for UI main, answering each `layoutVeta` with the place it would apply, and the test drives the grip.
 */
const KEY = 'Q27G2WG4|2560x1440|@1|0,0'
const HOME: VetaDock = { edge: 'bottom', end: 'end', offset: 16 }

function world(
  options: {
    place?: VetaLayoutResult
    stored?: UiPreferencesMap['vetaDock']
    length?: () => number
  } = {}
) {
  let place: VetaLayoutResult = options.place ?? { applied: true, displayKey: KEY, dock: HOME }
  const requests: VetaLayoutRequest[] = []
  const reads: UiPreferenceKey[][] = []
  const listeners = {
    dock: [] as ((e: VetaDockChanged) => void)[],
    reset: [] as ((e: { epoch: number }) => void)[],
    mode: [] as ((t: ModeTransition) => void)[]
  }
  const api = createFakeWindowApi({
    layoutVeta: (request) => {
      requests.push(request as VetaLayoutRequest)
      if (request.kind === 'dock-key') {
        place = {
          applied: true,
          displayKey: place.displayKey,
          dock: { ...place.dock, edge: request.edge }
        }
      }
      return Promise.resolve(place)
    },
    onVetaDockChanged: (h) => (listeners.dock.push(h), () => {}),
    onUiPreferencesReset: (h) => (listeners.reset.push(h), () => {}),
    onModeTransition: (h) => (listeners.mode.push(h), () => {}),
    getUiPreferences: (request) => {
      reads.push([...request.keys])
      return Promise.resolve({ vetaDock: options.stored ?? {} })
    }
  })
  const dock = useVetaDock({
    bridge: api,
    islandLength: options.length ?? (() => 480),
    windowOrigin: () => ({ x: 0, y: 0 })
  })
  return {
    dock,
    requests,
    reads,
    listeners,
    setPlace: (next: VetaLayoutResult) => (place = next)
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('useVetaDock (07 machine 21; 14 §2.2 A-N23, A-N28)', () => {
  it('[US-VETA-002.AC04, S21.11] an arrow key on the focused grip docks to the named edge with no drag, keeping end and offset', async () => {
    const { dock, requests } = world()
    await dock.start()
    expect(dock.dock.value).toEqual(HOME)
    expect(dock.vertical.value).toBe(false)
    requests.length = 0
    // ← names the left edge: one keyboard dock, no drag request, the same end and offset; the island turns vertical.
    expect(dock.keyDown('ArrowLeft')).toBe(true)
    await settle()
    expect(requests).toEqual([{ kind: 'dock-key', edge: 'left' }])
    expect(dock.dock.value).toEqual({ edge: 'left', end: 'end', offset: 16 })
    expect(dock.vertical.value).toBe(true)
    expect(dock.dragging.value).toBe(false)
    // Every arrow names its edge.
    for (const [key, edge] of [
      ['ArrowUp', 'top'],
      ['ArrowRight', 'right'],
      ['ArrowDown', 'bottom']
    ] as const) {
      dock.keyDown(key)
      await settle()
      expect(requests.at(-1)).toEqual({ kind: 'dock-key', edge })
    }
    // Any other key is not the dock's.
    expect(dock.keyDown('Enter')).toBe(false)
  })

  it('[S21.11] an arrow naming the current edge does nothing', async () => {
    const { dock, requests } = world()
    await dock.start()
    requests.length = 0
    expect(dock.keyDown('ArrowDown')).toBe(false)
    await settle()
    expect(requests).toEqual([])
    expect(dock.dock.value).toEqual(HOME)
  })

  it('[ADR-024] after onUiPreferencesReset the renderer re-reads vetaDock and takes the default place', async () => {
    const elsewhere: VetaLayoutResult = {
      applied: true,
      displayKey: 'PHL 243V7|1920x1080|@1|2560,357',
      dock: { edge: 'right', end: 'start', offset: 40 }
    }
    const { dock, listeners, reads, requests, setPlace } = world({ place: elsewhere })
    await dock.start()
    expect(dock.displayKey.value).toBe(elsewhere.displayKey)
    // Reset metrics: UI main rewrote every place and moved Veta to the default place, pushing no A-N28.
    setPlace({ applied: true, displayKey: KEY, dock: HOME })
    requests.length = 0
    for (const h of listeners.reset) h({ epoch: 3 })
    await settle()
    expect(reads).toEqual([['vetaDock']])
    // No place is stored for its display any more: it takes the default place UI main now holds.
    expect(requests).toEqual([{ kind: 'island-resize', length: 480 }])
    expect(dock.displayKey.value).toBe(KEY)
    expect(dock.dock.value).toEqual(HOME)
    expect(dock.vertical.value).toBe(false)
  })

  it('[S21.12, S21.13, US-VETA-002.AC03] a re-placement by UI main is taken at once, and cancels a drag in progress', async () => {
    const { dock, listeners, requests } = world()
    await dock.start()
    const facts = (x: number, y: number) => ({ screenX: x, screenY: y, clientX: x, clientY: y })
    dock.pointerDown(facts(1200, 1360))
    dock.pointerMove(facts(1260, 1300), { width: 2560, height: 1392 })
    expect(dock.dragging.value).toBe(true)
    expect(dock.preview.value).toBe('bottom')
    await settle()
    expect(requests.at(-1)).toEqual({ kind: 'drag-start', screenX: 1260, screenY: 1300 })
    // The strip follows the pointer by transform.
    expect(dock.follow.value).toEqual({ x: 60, y: -60 })
    // The display under the drag changed (FM-112): the drag is cancelled and the pushed place taken.
    const moved: VetaDockChanged = {
      displayKey: KEY,
      dock: { edge: 'bottom', end: 'start', offset: 16 },
      reason: 'display-removed'
    }
    for (const h of listeners.dock) h(moved)
    expect(dock.dragging.value).toBe(false)
    expect(dock.dock.value).toEqual(moved.dock)
    // A release after the cancel lands nothing.
    dock.pointerUp(facts(5, 5))
    await settle()
    expect(requests.some((r) => r.kind === 'drag-end')).toBe(false)
  })

  it('[S21.19, US-VETA-001.AC03] a new island length re-places the island at its place, saving nothing', async () => {
    let length = 80
    const { dock, requests } = world({ length: () => length })
    await dock.start()
    expect(requests).toEqual([{ kind: 'island-resize', length: 80 }])
    // The strip grew from the closed entrance to its chambers (ISSUE-287): UI main re-places it for that length.
    length = 230
    await dock.resized()
    expect(requests.at(-1)).toEqual({ kind: 'island-resize', length: 230 })
    expect(dock.dock.value).toEqual(HOME)
  })
})
