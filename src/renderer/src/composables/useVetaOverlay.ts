/*
 * The Veta window's room for an overlay (ADR-025 item 2; 07 N-25; 14 §2.2 A-N23 `layoutVeta {overlay}`; ISSUE-288).
 * The window hugs the island, so an overlay (the grip menu, the mine picker) needs it grown first: `open` asks UI main
 * for the room and the overlay shows only once that is answered; `close` hides it, waits for it to leave the page, and
 * only then asks for the room back. A window is never resized while an overlay is on screen in it.
 *
 * - Opening another overlay over an open one (the menu, then the picker) asks for the new room and keeps showing.
 * - An answer that arrives after a close never shows the overlay again (each request is stamped).
 * - `drop` forgets an overlay without asking for anything: a drag replaced the window by the drag surface, and UI
 *   main forgot the overlay with it (S22.17).
 * - UI main out of reach: the overlay shows anyway in the window it has, which is better than a control that does
 *   nothing at all.
 *
 * The mine tab's band (07 §24 I-22, N-25; ISSUE-289) is room the window holds for good while chambers are drawn, so a
 * hover never resizes it: `band` asks for it each time its size changes. An overlay's room is the box around the band
 * and the overlay, both on the screen side from the island's anchored end, and a closed overlay gives the window back
 * to the band, not to the bare island. After a `drop` the band is asked again.
 *
 * A risen Add panel (07 machine 24, S24.03; ISSUE-290) holds its room the same way (`hold`), apart from the menus: the
 * Add panel names no dwarf for `layoutVeta {rise}`, so its room rides with the band, asked before it rises and given
 * back after its fold (S24.09); a menu opening or closing meanwhile never touches it, and a drag forgets it.
 *
 * The bridge is injected (the house idiom over `vi.mock`).
 */
import type { VetaLayoutRequest, VetaLayoutResult } from '@dwarfai/contracts'
import { nextTick, ref, type Ref } from 'vue'

/** The seam A member the overlay uses (14 §2.2 A-N23). */
export interface VetaOverlayBridge {
  layoutVeta(request: VetaLayoutRequest): Promise<VetaLayoutResult>
}

export interface VetaOverlayDeps {
  bridge: VetaOverlayBridge
}

type Size = { width: number; height: number }

export interface VetaOverlay {
  /** Whether the overlay may be drawn: the window has its room. */
  shown: Readonly<Ref<boolean>>
  /** Grows the window for an overlay of `size` (its gap to the island included), then shows it. */
  open(size: Size): Promise<void>
  /** Hides the overlay, then gives the room back once it has left the page. */
  close(): Promise<void>
  /** Hides the overlay with no request: UI main already forgot it (a drag started). */
  drop(): void
  /** The mine tab's band, held in the window from now on; `null` when no chamber is drawn. */
  band(size: Size | null): Promise<void>
  /** A risen Add panel's room (07 machine 24), held beside the band apart from any menu; `null` gives it back. */
  hold(size: Size | null): Promise<void>
}

const same = (a: Size | null, b: Size | null): boolean =>
  a === b || (a !== null && b !== null && a.width === b.width && a.height === b.height)

export function useVetaOverlay(deps: VetaOverlayDeps): VetaOverlay {
  const shown = ref(false)
  /** The band the mine tab rises into. */
  let band: Size | null = null
  /** The open overlay's room. */
  let current: Size | null = null
  /** A risen Add panel's room (ISSUE-290), held apart from the menus so one opening or closing never touches it. */
  let risen: Size | null = null
  /** The room UI main holds; `undefined` when not known (nothing asked yet, or forgotten by a drag). */
  let held: Size | null | undefined = undefined
  /** Stamps each open and close, so a late answer is told apart. */
  let stamp = 0

  /** The room for the band, the open overlay and a risen Add panel together. */
  function room(): Size | null {
    const rooms = [band, current, risen].filter((r): r is Size => r !== null)
    if (rooms.length === 0) return null
    return {
      width: Math.max(...rooms.map((r) => r.width)),
      height: Math.max(...rooms.map((r) => r.height))
    }
  }

  async function ask(bounds: Size | null): Promise<void> {
    held = bounds
    try {
      await deps.bridge.layoutVeta({ kind: 'overlay', bounds })
    } catch {
      // UI main is unreachable: the window keeps the size it has.
    }
  }

  return {
    shown,
    async open(size) {
      const mine = ++stamp
      current = { width: Math.ceil(size.width), height: Math.ceil(size.height) }
      await ask(room())
      if (mine === stamp) shown.value = true
    },
    async close() {
      ++stamp
      shown.value = false
      if (current === null) return
      current = null
      await nextTick()
      await ask(room())
    },
    drop() {
      ++stamp
      shown.value = false
      current = null
      risen = null
      held = undefined
    },
    async hold(size) {
      risen =
        size === null ? null : { width: Math.ceil(size.width), height: Math.ceil(size.height) }
      await ask(room())
    },
    async band(size) {
      band = size === null ? null : { width: Math.ceil(size.width), height: Math.ceil(size.height) }
      const next = room()
      if (held !== undefined && same(next, held)) return
      // Nothing known to be held and nothing to hold: there is nothing to ask for.
      if (held === undefined && next === null) return
      await ask(next)
    }
  }
}

/** The overlay room over the page's own `window.api` (R13: `window.api` is read in composables only). */
export function useWindowVetaOverlay(): VetaOverlay {
  return useVetaOverlay({ bridge: window.api })
}
