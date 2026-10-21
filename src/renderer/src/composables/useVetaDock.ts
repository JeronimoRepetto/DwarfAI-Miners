/*
 * The Veta renderer's dock (07 machine 21; US-VETA-002; 14 §2.2 A-N23 `layoutVeta`, A-N28 `onVetaDockChanged`; 14 §3.9
 * usage rule). The gesture itself is `lib/veta/dockGesture.ts`; this composable feeds it the grip's pointer events and
 * carries out what it answers:
 *
 * - `drag-start`: UI main grows the window to the work area of the display under the pointer (the drag surface); the
 *   strip then follows the pointer by transform (`follow`) and the dashed preview shows on the nearest edge (`preview`).
 * - `drag-end`: UI main lands the island and answers the place it applied; refused (S21.20), the place before the press
 *   stands; a failed call puts the island back the same way as a cancel.
 * - `restore` (a cancelled drag, S21.10): UI main re-places the island at its place for its length (`island-resize`),
 *   saving nothing.
 * - Arrow keys on the focused grip dock to the named edge (S21.11); the edge it is on already does nothing.
 * - A-N28: UI main re-placed Veta after a display change; the place is taken at once and a drag in progress is
 *   cancelled (FM-112). A-N12: after Reset metrics the renderer re-reads `vetaDock` (A-N20) and takes its stored place
 *   for its display, or, with none stored, the default place UI main now holds.
 *
 * The orientation follows the edge: vertical on a left or right edge, the parts swapping width and height
 * (US-VETA-002.AC08). The bridge, the island's length and the window's screen origin are injected (the house idiom over
 * `vi.mock`).
 */
import {
  VETA_ISLAND_STAND_IN,
  type ModeTransition,
  type UiPreferenceKey,
  type UiPreferencesMap,
  type VetaDock,
  type VetaDockChanged,
  type VetaLayoutRequest,
  type VetaLayoutResult
} from '@dwarfai/contracts'
import { computed, ref, shallowRef } from 'vue'
import {
  IDLE_GESTURE,
  stepGesture,
  type CancelCause,
  type GestureEffect,
  type GestureInput,
  type GestureState,
  type Point
} from '../lib/veta/dockGesture'

/** The seam A members the dock uses (14 §2.2 A-N23, A-N28, A-N12, A-N14, A-N20). */
export interface VetaDockBridge {
  layoutVeta(request: VetaLayoutRequest): Promise<VetaLayoutResult>
  onVetaDockChanged(h: (e: VetaDockChanged) => void): () => void
  onUiPreferencesReset(h: (e: { epoch: number }) => void): () => void
  onModeTransition(h: (t: ModeTransition) => void): () => void
  getUiPreferences(request: { keys: UiPreferenceKey[] }): Promise<Partial<UiPreferencesMap>>
}

export interface VetaDockDeps {
  bridge: VetaDockBridge
  /** The island's length along its edge, in CSS pixels. */
  islandLength(): number
  /** The window's top-left corner on the screen (`window.screenX`, `window.screenY`). */
  windowOrigin(): Point
}

/** A pointer event's positions on the screen and in the window. */
export interface PointerAt {
  screenX: number
  screenY: number
  clientX: number
  clientY: number
}

const ARROW_EDGES: Readonly<Record<string, VetaDock['edge']>> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'top',
  ArrowDown: 'bottom'
}

/** Until UI main answers: the default place's edge and end (07 S21.02); the first answer replaces it. */
const BEFORE_FIRST_ANSWER: VetaDock = { edge: 'bottom', end: 'end', offset: 16 }

export function useVetaDock(deps: VetaDockDeps) {
  const { bridge } = deps
  const dock = ref<VetaDock>({ ...BEFORE_FIRST_ANSWER })
  const displayKey = ref('')
  const gesture = shallowRef<GestureState>(IDLE_GESTURE)
  /** The island's screen corner at the press: the strip is drawn there, plus the pointer's travel. */
  let islandAt: Point = { x: 0, y: 0 }
  const follow = ref<Point>({ x: 0, y: 0 })
  const unsubscribe: (() => void)[] = []

  const vertical = computed(() => dock.value.edge === 'left' || dock.value.edge === 'right')
  const dragging = computed(() => gesture.value.phase === 'dragging')
  const preview = computed(() =>
    gesture.value.phase === 'dragging' ? gesture.value.preview : null
  )

  function take(place: { displayKey: string; dock: VetaDock }): void {
    displayKey.value = place.displayKey
    dock.value = { ...place.dock }
  }

  /** The island at its place for its length, from UI main (S21.10 restore, S21.19, first show). */
  async function replace(): Promise<void> {
    try {
      take(await bridge.layoutVeta({ kind: 'island-resize', length: deps.islandLength() }))
    } catch {
      // UI main is unreachable: the last place known is still the most honest one to draw.
    }
  }

  function step(input: GestureInput): GestureEffect {
    const next = stepGesture(gesture.value, input)
    gesture.value = next.state
    return next.effect
  }

  function carryOut(effect: GestureEffect): void {
    switch (effect.kind) {
      case 'drag-start':
        void bridge
          .layoutVeta({ kind: 'drag-start', screenX: effect.screen.x, screenY: effect.screen.y })
          .then(
            (result) => {
              // Docking is not available (native Wayland, S21.16): the drag changes nothing.
              if (!result.applied) step({ type: 'cancel', cause: 'pointer-cancel' })
              else step({ type: 'surface-ready' })
            },
            () => carryOut(step({ type: 'cancel', cause: 'pointer-cancel' }))
          )
        return
      case 'drag-end':
        follow.value = { x: 0, y: 0 }
        void bridge
          .layoutVeta({ kind: 'drag-end', screenX: effect.screen.x, screenY: effect.screen.y })
          .then(
            (result) => {
              // Applied: the new place (S21.09); refused: UI main put it back where it was (S21.20).
              take(result)
              step({ type: 'landed' })
            },
            () => {
              step({ type: 'landed' })
              void replace()
            }
          )
        return
      case 'restore':
        follow.value = { x: 0, y: 0 }
        void replace()
        return
      case 'click':
      case 'none':
        return
    }
  }

  /** Cancels a press or a drag (S21.10): pointercancel, lost capture, hidden, a mode change. */
  function cancel(cause: CancelCause): void {
    const effect = step({ type: 'cancel', cause })
    // A display change re-placed Veta already (A-N28): there is nothing to put back.
    if (cause !== 'display-change') carryOut(effect)
    else follow.value = { x: 0, y: 0 }
  }

  return {
    /** Where the island is docked on its display. */
    dock,
    displayKey,
    /** On a left or right edge the island is vertical (US-VETA-002.AC08). */
    vertical,
    /** `.is-dragging`. */
    dragging,
    /** The edge where the dashed snap preview shows, while dragging. */
    preview,
    /** The strip's translation while it follows the pointer, in CSS pixels. */
    follow,

    /** Subscribes to UI main's pushes and learns the island's place. */
    async start(): Promise<void> {
      unsubscribe.push(
        bridge.onVetaDockChanged((changed) => {
          if (gesture.value.phase !== 'docked') cancel('display-change')
          take(changed)
        }),
        bridge.onUiPreferencesReset(() => {
          void (async () => {
            const stored = (await bridge.getUiPreferences({ keys: ['vetaDock'] })).vetaDock ?? {}
            const own = stored[displayKey.value]
            if (own !== undefined) dock.value = { ...own }
            else await replace()
          })().catch(() => {
            // Unreachable: the next answer from UI main corrects the place.
          })
        }),
        bridge.onModeTransition((t) => {
          if (t.role === 'source') cancel('mode-change')
        })
      )
      await replace()
    },

    /** A key on the focused grip; true when the dock took it (the caller then prevents its default). */
    keyDown(key: string): boolean {
      const edge = ARROW_EDGES[key]
      if (edge === undefined || edge === dock.value.edge || gesture.value.phase !== 'docked') {
        return false
      }
      void bridge.layoutVeta({ kind: 'dock-key', edge }).then(
        (result) => {
          if (result.applied) take(result)
        },
        () => {
          // Unreachable: nothing moved.
        }
      )
      return true
    },

    pointerDown(p: PointerAt): void {
      islandAt = deps.windowOrigin()
      carryOut(
        step({
          type: 'press',
          screen: { x: p.screenX, y: p.screenY },
          client: { x: p.clientX, y: p.clientY },
          surface: { width: 0, height: 0 }
        })
      )
    },

    pointerMove(p: PointerAt, surface: { width: number; height: number }): void {
      carryOut(
        step({
          type: 'move',
          screen: { x: p.screenX, y: p.screenY },
          client: { x: p.clientX, y: p.clientY },
          surface
        })
      )
      const now = gesture.value
      if (now.phase !== 'dragging') return
      const origin = deps.windowOrigin()
      follow.value = {
        x: now.pointer.x - now.start.x + islandAt.x - origin.x,
        y: now.pointer.y - now.start.y + islandAt.y - origin.y
      }
    },

    pointerUp(p: PointerAt): void {
      carryOut(
        step({
          type: 'release',
          screen: { x: p.screenX, y: p.screenY },
          client: { x: p.clientX, y: p.clientY },
          surface: { width: 0, height: 0 }
        })
      )
    },

    cancel,

    dispose(): void {
      for (const off of unsubscribe.splice(0)) off()
    }
  }
}

/** The dock as the Veta root uses it. */
export type VetaDockPart = ReturnType<typeof useVetaDock>

/** The dock over the page's own `window.api` and window (R13: `window.api` is read in composables only). */
export function useWindowVetaDock(): VetaDockPart {
  return useVetaDock({
    bridge: window.api,
    islandLength: () => VETA_ISLAND_STAND_IN.length,
    windowOrigin: () => ({ x: window.screenX, y: window.screenY })
  })
}
