/*
 * The reveal of a notification click while Valle is the mode (07 S39.06, S39.07, S10.10, S10.11; ADR-025 item 8;
 * ADR-018 item 6; UC-064; ISSUE-311). UI main pushes A-N16 `onRevealDwarfChat {mineId, dwarfId | null}` to the Valle
 * window; Valle reveals the dwarf in the preset shown, which it never changes, and never moves the mode.
 *
 * - A page over the main zone gives way to the mines first (S28.20).
 * - The Control room: the mine's column added when missing (S32.14, the mosaic's), scrolled into view when outside the
 *   viewport (smooth, a jump under reduced motion, NFR-A11Y-10) with `mosaicScrollLeft` updated for the session
 *   (ADR-024), the chat pinned and focused with its question or permission card (S29.19, the pins'), the mine made
 *   current (S35.01, the current mine's).
 * - The Work front: a swap to the mine when another is shown (S28.15, the preset's own swap), then the dwarf's tab
 *   selected (S29.19).
 * - `'mine-only'` (S39.07): `dwarfId` null, or a dwarf no longer present: the mine brought into view, no chat.
 * - A hidden Valle (S10.11): UI main restores the window in its own mode first; the reveal plays once it is shown, so
 *   the scroll measures a laid-out mosaic.
 *
 * Every part goes through the composable that owns it, one writer per key; the parts and the scroller are injected.
 * Every scroll to a zone, a needs-you jump's included, goes through `scrollIntoView`.
 */
import type { DwarfId, MineId, RevealDwarfChatPush, UiSessionPatch } from '@dwarfai/contracts'
import type { ValleNavPage, VallePreset } from '../lib/valle/preset'
import { zoneScrollLeft, type MosaicViewport, type MosaicZone } from '../lib/valle/reveal'

/** What A-N16 asks Valle to reveal (14 §3.8): `dwarfId` null when the dwarf left. */
export interface ValleRevealTarget {
  readonly mineId: MineId
  readonly dwarfId: DwarfId | null
}

/** What the reveal came to (16 §4.14 `RevealOutcome`). */
export type ValleRevealOutcome = 'chat-open' | 'mine-only'

/** The seam A member the Valle window hears a reveal on (14 §2.2 A-N16). */
export interface ValleRevealBridge {
  onRevealDwarfChat(listener: (target: RevealDwarfChatPush) => void): () => void
}

/** The parts of a reveal, each through the composable that owns it. */
export interface ValleRevealParts {
  /** S28.20: the page over the main zone closes, the preset beneath shown. */
  leavePage(): void
  /** S32.14: the mine's column appended when absent, then scrolled to (the mosaic, through `scrollIntoView`). */
  column(mineId: MineId): void
  /** S29.19: the dwarf's chat pinned when absent, then focused (the pins). */
  pin(dwarfId: DwarfId, mineId: MineId): void
  /** S35.01: the mine made current (the current mine). */
  current(mineId: MineId): void
  /** S28.15: the Work front swapped to the mine, its tab order led by the dwarf (the preset's own swap). */
  swap(mineId: MineId, dwarfId: DwarfId | null): void
}

/** The Control room's mosaic as the scroll reads and moves it. */
export interface ValleMosaicScroller {
  /** The mosaic's viewport; null while it is not drawn. */
  viewport(): MosaicViewport | null
  /** The mine's zone in the mosaic's content coordinates; null when it has no column. */
  zone(mineId: MineId): MosaicZone | null
  scrollTo(left: number, behavior: ScrollBehavior): void
}

export interface ValleRevealDeps {
  /** The preset shown, a page over it, and the Work front's mine: read only. */
  view(): { preset: VallePreset; page: ValleNavPage | null; frontMine: MineId | null }
  /** Whether the dwarf is still in the Valle read model. */
  present(dwarfId: DwarfId): boolean
  /** Whether the Valle window is shown. */
  shown(): boolean
  /** The person asked for reduced motion. */
  reduced(): boolean
  parts: ValleRevealParts
  scroller: ValleMosaicScroller
  /** A-N18: the saved mosaic scroll (`valle.mosaicScrollLeft`). */
  patchUiSession(patch: UiSessionPatch): void
}

export interface ValleRevealPart {
  /** A-N16 heard: reveals now, or once a hidden window is shown again. */
  reveal(target: ValleRevealTarget): ValleRevealOutcome
  /** Scrolls the mosaic to bring the mine's zone into view, saving the scroll; nothing when it is in view. */
  scrollIntoView(mineId: MineId): void
  /** The window was shown or hidden: a reveal held while hidden plays once shown. */
  shownChanged(): void
}

export function useValleReveal(deps: ValleRevealDeps): ValleRevealPart {
  const { parts } = deps
  let held: ValleRevealTarget | null = null

  function play(target: ValleRevealTarget): void {
    const { mineId } = target
    const dwarfId = target.dwarfId !== null && deps.present(target.dwarfId) ? target.dwarfId : null
    if (deps.view().page !== null) parts.leavePage()
    const { preset, frontMine } = deps.view()
    if (preset === 'front') {
      if (frontMine !== mineId) parts.swap(mineId, dwarfId)
      if (dwarfId !== null) parts.pin(dwarfId, mineId)
      return
    }
    parts.column(mineId)
    if (dwarfId !== null) parts.pin(dwarfId, mineId)
    parts.current(mineId)
  }

  return {
    reveal(target) {
      const outcome: ValleRevealOutcome =
        target.dwarfId !== null && deps.present(target.dwarfId) ? 'chat-open' : 'mine-only'
      if (deps.shown()) play(target)
      else held = target
      return outcome
    },
    scrollIntoView(mineId) {
      const viewport = deps.scroller.viewport()
      const zone = deps.scroller.zone(mineId)
      if (viewport === null || zone === null) return
      const left = zoneScrollLeft(viewport, zone)
      if (left === null) return
      // NFR-A11Y-10, US-SHELL-011.AC06: under reduced motion the scroll jumps.
      deps.scroller.scrollTo(left, deps.reduced() ? 'auto' : 'smooth')
      deps.patchUiSession({ kind: 'valle', patch: { mosaicScrollLeft: left } })
    },
    shownChanged() {
      if (held === null || !deps.shown()) return
      const target = held
      held = null
      play(target)
    }
  }
}
