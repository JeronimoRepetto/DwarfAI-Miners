/*
 * Mounts the Veta root over the generated fake `window.api` for the grip menu and mine picker tests (ISSUE-288; 17
 * §2.2): fixture snapshots stand in for the Host, and UI main's answers are scripted. `layoutVeta {overlay}` answers
 * can be held back to see what shows before the window has grown. Never imported by production code (R14).
 */
import type { MoveToModeParams, VetaLayoutRequest, VetaLayoutResult } from '@dwarfai/contracts'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createFakeWindowApi } from '../../../../../contracts/ipc/testing/fakeWindowApi'
import { FRAME_CLOCK_KEY } from '../../../composables/useFramePlayer'
import { createFrameClock } from '../../../lib/sprite/frameClock'
import { FakeTickSource, fakeFrameClockEnv } from '../../../lib/sprite/testing/FakeTickSource'
import { snapshotPage, type VetaSnapshotData } from '../../../lib/veta/testing/vetaFixtures'
import type { MineDeclareResult } from '../../../types'
import VetaApp from '../VetaApp.vue'

export const VETA_PLACE: VetaLayoutResult = {
  applied: true,
  displayKey: 'Q27G2WG4|2560x1440|@1|0,0',
  dock: { edge: 'bottom', end: 'end', offset: 16 }
}

export interface VetaWorldOptions {
  /** A-30's answer; an Error rejects. */
  declare?: MineDeclareResult | Error
  /** A-31's answer. */
  declareMain?: MineDeclareResult
  /** Holds back each `overlay` answer until `answerOverlays` is called. */
  holdOverlays?: boolean
  /** Where UI main answers the island is docked; `VETA_PLACE` by default. */
  place?: VetaLayoutResult
}

export interface VetaWorld {
  root: VueWrapper
  moves: MoveToModeParams[]
  layouts: VetaLayoutRequest[]
  declares: string[]
  /** What the page showed each time UI main was asked for an overlay's room: `menu`, `picker` or `none`. */
  shownAtLayout: string[]
  /** Answers every held `overlay` request. */
  answerOverlays(): Promise<void>
  unmount(): void
}

/** What overlay the page shows now, by its data attributes. */
export function shownOverlay(): string {
  const box = document.querySelector<HTMLElement>('[data-veta-overlay]')
  if (box === null || box.dataset.shown !== 'true') return 'none'
  if (box.querySelector('[data-mine-picker]') !== null) return 'picker'
  if (box.querySelector('[data-veta-grip-menu]') !== null) return 'menu'
  return 'none'
}

export async function mountVeta(
  data: VetaSnapshotData,
  options: VetaWorldOptions = {}
): Promise<VetaWorld> {
  const moves: MoveToModeParams[] = []
  const layouts: VetaLayoutRequest[] = []
  const declares: string[] = []
  const shownAtLayout: string[] = []
  const held: Array<() => void> = []
  ;(window as unknown as { api: unknown }).api = createFakeWindowApi({
    getHostSnapshot: () => Promise.resolve(snapshotPage(10, data)) as never,
    onHostEvent: () => () => undefined,
    moveToMode: (request) => {
      moves.push(request as MoveToModeParams)
      return Promise.resolve({ ok: true, value: undefined })
    },
    layoutVeta: (request) => {
      const place = options.place ?? VETA_PLACE
      layouts.push(request as VetaLayoutRequest)
      if (request.kind !== 'overlay') return Promise.resolve(place)
      shownAtLayout.push(shownOverlay())
      if (options.holdOverlays !== true) return Promise.resolve(place)
      return new Promise((resolve) => held.push(() => resolve(place)))
    },
    declareMine: () => {
      declares.push('declareMine')
      const answer = options.declare ?? { outcome: 'cancelled' }
      return (answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)) as never
    },
    declareMainProject: () => {
      declares.push('declareMainProject')
      return Promise.resolve(
        options.declareMain ?? { outcome: 'failed', reason: 'That folder could not be added.' }
      ) as never
    }
  })
  const clock = createFrameClock(fakeFrameClockEnv(new FakeTickSource()).env)
  const root = mount(VetaApp, {
    attachTo: document.body,
    global: { provide: { [FRAME_CLOCK_KEY as symbol]: clock } }
  })
  await flushPromises()
  return {
    root,
    moves,
    layouts,
    declares,
    shownAtLayout,
    async answerOverlays() {
      for (const answer of held.splice(0)) answer()
      await flushPromises()
    },
    unmount() {
      root.unmount()
      clock.dispose()
      delete (window as unknown as { api?: unknown }).api
    }
  }
}
