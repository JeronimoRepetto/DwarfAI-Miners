/*
 * The Veta island's length along its edge (ISSUE-287; `DS/docs/components.md`, Veta strip, "How many chambers fit, as
 * arithmetic"; `DS/docs/screens/veta.md` Layout). The renderer reports it to UI main with `layoutVeta {island-resize}`
 * (A-N23), so the window hugs the strip it draws; the thickness across the edge is `VETA_ISLAND.thickness` on every
 * edge. On a left or right edge the parts swap width and height.
 *
 * - The closed entrance (`first-run`, `no-sessions`): 2 × 2 px island padding + the 72 px entrance with its 2 × 2 px
 *   margin = 80 px.
 * - A strip: 2 × 2 px padding + expand and grip (32 px each with a 2 × 2 px margin) + every chamber shown. A chamber
 *   with k dwarfs is 2 × 2 px margin + its padding (10 + 8 px) + k sprites (36 px wide in a row, 38 px tall in a shaft)
 *   + (k − 1) × 4 px gaps: 40k + 18 px in a row, 42k + 18 px in a shaft. Sprites never shrink.
 *
 * Pure.
 */
import { VETA_ISLAND } from '@dwarfai/contracts'

/** What the island draws: the closed entrance, or chambers holding `crews[i]` dwarfs each, in order. */
export type IslandParts = { kind: 'entrance' } | { kind: 'chambers'; crews: readonly number[] }

const ISLAND_PADDING = 2 * 2
/** Expand or grip: 32 px with a 2 px margin on each side. */
const BUTTON_ALONG = 32 + 2 * 2
const CHAMBER_GAP = 4
/** The chamber's padding along the edge (10 + 8 px) and its margin (2 × 2 px). */
const CHAMBER_FRAME = 10 + 8 + 2 * 2
const SPRITE_ALONG = { row: 36, shaft: 38 } as const

function chamberLength(dwarfs: number, vertical: boolean): number {
  const sprite = vertical ? SPRITE_ALONG.shaft : SPRITE_ALONG.row
  return CHAMBER_FRAME + dwarfs * sprite + Math.max(0, dwarfs - 1) * CHAMBER_GAP
}

/** The island's length along its edge, in CSS pixels. */
export function islandLength(parts: IslandParts, vertical: boolean): number {
  if (parts.kind === 'entrance') return VETA_ISLAND.length
  return (
    ISLAND_PADDING +
    2 * BUTTON_ALONG +
    parts.crews.reduce((sum, dwarfs) => sum + chamberLength(dwarfs, vertical), 0)
  )
}
