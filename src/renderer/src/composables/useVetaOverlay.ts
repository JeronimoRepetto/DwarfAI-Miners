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

export interface VetaOverlay {
  /** Whether the overlay may be drawn: the window has its room. */
  shown: Readonly<Ref<boolean>>
  /** Grows the window for an overlay of `size` (its gap to the island included), then shows it. */
  open(size: { width: number; height: number }): Promise<void>
  /** Hides the overlay, then gives the room back once it has left the page. */
  close(): Promise<void>
  /** Hides the overlay with no request: UI main already forgot it (a drag started). */
  drop(): void
}

export function useVetaOverlay(deps: VetaOverlayDeps): VetaOverlay {
  const shown = ref(false)
  /** Whether UI main holds room for an overlay. */
  let grown = false
  /** Stamps each open and close, so a late answer is told apart. */
  let stamp = 0

  async function ask(bounds: { width: number; height: number } | null): Promise<void> {
    try {
      await deps.bridge.layoutVeta({ kind: 'overlay', bounds })
    } catch {
      // UI main is out of reach: the window keeps the size it has.
    }
  }

  return {
    shown,
    async open(size) {
      const mine = ++stamp
      grown = true
      await ask({ width: Math.ceil(size.width), height: Math.ceil(size.height) })
      if (mine === stamp) shown.value = true
    },
    async close() {
      ++stamp
      shown.value = false
      if (!grown) return
      grown = false
      await nextTick()
      await ask(null)
    },
    drop() {
      ++stamp
      shown.value = false
      grown = false
    }
  }
}

/** The overlay room over the page's own `window.api` (R13: `window.api` is read in composables only). */
export function useWindowVetaOverlay(): VetaOverlay {
  return useVetaOverlay({ bridge: window.api })
}
