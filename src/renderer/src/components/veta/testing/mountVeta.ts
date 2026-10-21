/*
 * Mounts the Veta root over the generated fake `window.api` for the grip menu and mine picker tests (ISSUE-288; 17
 * §2.2): fixture snapshots stand in for the Host, and UI main's answers are scripted. `layoutVeta {overlay}` answers
 * can be held back to see what shows before the window has grown. Never imported by production code (R14).
 */
import type {
  HostFrame,
  MoveToModeParams,
  UiSessionPatch,
  UiSessionSnapshot,
  VetaLayoutRequest,
  VetaLayoutResult
} from '@dwarfai/contracts'
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
  /**
   * Plays the risen window's motion for real (ISSUE-290). By default the page prefers reduced motion, so a rise or a
   * fold settles within the promises a test flushes instead of on a transition jsdom never ends.
   */
  motion?: boolean
  /** Holds back each `rise` answer until `answerRises` is called. */
  holdRises?: boolean
  /** UI main's session store, as A-N17 answers it (ISSUE-290); its drafts and chat views, the chats talked to. */
  session?: Partial<UiSessionSnapshot>
  /** Called with each A-N23 request as UI main receives it, before it answers (ISSUE-291). */
  onLayout?: (request: VetaLayoutRequest) => void
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
  /** Answers every held `rise` request. */
  answerRises(): Promise<void>
  /** Whether the risen window showed each time UI main was asked for a `rise` or a `fold`. */
  risenAtLayout: string[]
  /** Every A-N18 patch the page sent. */
  patches: UiSessionPatch[]
  /** Relays Host frames to the page as UI main does over A-N02 (ISSUE-292), then lets it settle. */
  push(frames: HostFrame[]): Promise<void>
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

/** What the risen window shows now: `shown`, `hidden` (drawn, not shown) or `none`. */
export function shownRisen(): string {
  const box = document.querySelector<HTMLElement>('[data-veta-risen]')
  if (box === null) return 'none'
  return box.dataset.shown === 'true' ? 'shown' : 'hidden'
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
  const heldRises: Array<() => void> = []
  const risenAtLayout: string[] = []
  const patches: UiSessionPatch[] = []
  const hostListeners = new Set<(frames: HostFrame[]) => void>()
  const matchMedia = window.matchMedia
  if (options.motion !== true) {
    window.matchMedia = ((query: string) => ({
      matches: query.includes('prefers-reduced-motion: reduce'),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false
    })) as unknown as typeof window.matchMedia
  }
  ;(window as unknown as { api: unknown }).api = createFakeWindowApi({
    getHostSnapshot: () => Promise.resolve(snapshotPage(10, data)) as never,
    onHostEvent: (listener) => {
      hostListeners.add(listener as (frames: HostFrame[]) => void)
      return () => hostListeners.delete(listener as (frames: HostFrame[]) => void)
    },
    getUiSession: () =>
      Promise.resolve({
        drafts: {},
        chatViews: {},
        askPicks: {},
        openChat: {},
        currentMine: {},
        valle: {},
        ...options.session
      } as UiSessionSnapshot) as never,
    patchUiSession: (patch) => {
      patches.push(patch as UiSessionPatch)
    },
    moveToMode: (request) => {
      moves.push(request as MoveToModeParams)
      return Promise.resolve({ ok: true, value: undefined })
    },
    layoutVeta: (request) => {
      const place = options.place ?? VETA_PLACE
      layouts.push(request as VetaLayoutRequest)
      options.onLayout?.(request as VetaLayoutRequest)
      if (request.kind === 'rise' || request.kind === 'fold') {
        risenAtLayout.push(`${request.kind}:${shownRisen()}`)
        if (request.kind === 'rise' && options.holdRises === true) {
          return new Promise((resolve) => heldRises.push(() => resolve(place)))
        }
        return Promise.resolve(place)
      }
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
    async answerRises() {
      for (const answer of heldRises.splice(0)) answer()
      await flushPromises()
    },
    risenAtLayout,
    patches,
    async push(frames) {
      for (const listener of [...hostListeners]) listener(frames)
      await flushPromises()
    },
    unmount() {
      root.unmount()
      clock.dispose()
      window.matchMedia = matchMedia
      delete (window as unknown as { api?: unknown }).api
    }
  }
}
