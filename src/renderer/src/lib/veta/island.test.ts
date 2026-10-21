import { VETA_ISLAND } from '@dwarfai/contracts'
import { describe, expect, it } from 'vitest'
import { islandLength } from './island'

/*
 * ISSUE-287: the Veta island's length along its edge, the lengths `DS/docs/components.md` (Veta strip, How many
 * chambers fit, as arithmetic) adds up, so the window UI main places hugs the strip the renderer draws.
 */
describe('islandLength', () => {
  it('[US-VETA-001.AC03, US-VETA-002.AC08] the closed entrance is 80 px along any edge, and a strip adds its expand, chambers and grip', () => {
    // The closed entrance alone: 2 × 2 px island padding + 2 × 2 px margin + the 72 px entrance.
    expect(islandLength({ kind: 'entrance' }, false)).toBe(VETA_ISLAND.length)
    expect(islandLength({ kind: 'entrance' }, true)).toBe(80)
    // 4 px padding + expand 36 + grip 36 + each chamber with k dwarfs, 40k + 18 along a top or bottom edge.
    expect(islandLength({ kind: 'chambers', crews: [1] }, false)).toBe(4 + 36 + 36 + 58)
    expect(islandLength({ kind: 'chambers', crews: [4, 3, 1, 1] }, false)).toBe(
      4 + 36 + 36 + 178 + 138 + 58 + 58
    )
    // On a side edge the chamber is a shaft: 38 px sprites and 4 px gaps down it, 10 + 8 px padding, 42k + 18.
    expect(islandLength({ kind: 'chambers', crews: [2] }, true)).toBe(4 + 36 + 36 + 102)
  })
})
