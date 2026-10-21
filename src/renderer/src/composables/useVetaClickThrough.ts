/*
 * Veta's click-through (ADR-025 item 4; 14 §2.2 A-N22 `setVetaClickThrough`). The Veta window hugs the
 * island, but the island's shape leaves transparent corners, and those must never swallow a click meant
 * for another app. So the renderer hit-tests every pointer move against the island's shape and asks UI
 * main to ignore the mouse over a transparent part and to take it back over the island. Ignoring keeps
 * mouse moves forwarded to the page (`forward: true`), which is how the pointer coming back is seen.
 *
 * A-N22 is sent only when the answer changes: a move inside the same region sends nothing. On Linux,
 * where moves are not forwarded, UI main changes nothing and the bounds hugging the island are the rule
 * (S-025-3); the renderer does not need to know which OS it runs on.
 *
 * The window always holds the band the mine tab rises into (07 §24 I-22; ISSUE-289), so the band is click-through
 * except over a risen tab (`vetaTakesPointer`).
 *
 * The bridge and the island's shape are injected (the house idiom over `vi.mock`).
 */

/** The seam A member this composable uses (14 §2.2 A-N22). */
export interface VetaClickThroughBridge {
  setVetaClickThrough(p: { ignore: boolean }): void
}

export interface VetaClickThroughDeps {
  bridge: VetaClickThroughBridge
  /** Whether a point of the window, in CSS pixels, lies on the island's painted shape. */
  overIsland(x: number, y: number): boolean
}

export interface VetaClickThrough {
  /** A pointer move at `(x, y)`, in the window's CSS pixels. */
  pointerMoved(x: number, y: number): void
}

export function useVetaClickThrough(deps: VetaClickThroughDeps): VetaClickThrough {
  // Unknown until the first move, which always sends: a page reloaded after a crash cannot know what UI main
  // applied last, and a window left ignoring the mouse over the island could not be clicked at all.
  let ignoring: boolean | null = null
  return {
    pointerMoved(x, y) {
      const ignore = !deps.overIsland(x, y)
      if (ignore === ignoring) return
      ignoring = ignore
      deps.bridge.setVetaClickThrough({ ignore })
    }
  }
}

/**
 * Whether the element under the pointer takes the mouse (ADR-025 item 4; UC-047): the island, a risen mine tab, an
 * open overlay's card and the risen chat or Add panel (07 machine 24; ISSUE-290) do. The rest of the window is transparent room: the band the mine tab rises into (07 §24 I-22),
 * held in the window for good, and an overlay's gap. A folded tab is part of that band, even while it fades out.
 */
export function vetaTakesPointer(hit: Element | null): boolean {
  if (hit === null) return false
  const tab = hit.closest('[data-veta-tab]')
  if (tab !== null) return tab.getAttribute('data-risen') === 'true'
  return hit.closest('[data-veta-island], [data-veta-overlay-card], [data-veta-risen]') !== null
}

/** Click-through over the page's own `window.api` (R13: `window.api` is read in composables only). */
export function useWindowVetaClickThrough(
  overIsland: VetaClickThroughDeps['overIsland']
): VetaClickThrough {
  return useVetaClickThrough({ bridge: window.api, overIsland })
}
