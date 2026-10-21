import { describe, expect, it } from 'vitest'
import { useVetaClickThrough } from './useVetaClickThrough'

/** An island 300 × 60 at (10, 10) whose four corners, 12 px round, are transparent. */
const RADIUS = 12
function overIsland(x: number, y: number): boolean {
  const [left, top, right, bottom] = [10, 10, 310, 70]
  if (x < left || x >= right || y < top || y >= bottom) return false
  const cx = Math.min(Math.max(x, left + RADIUS), right - RADIUS)
  const cy = Math.min(Math.max(y, top + RADIUS), bottom - RADIUS)
  return (x - cx) ** 2 + (y - cy) ** 2 <= RADIUS ** 2
}

describe('useVetaClickThrough (ADR-025 item 4; 14 §2.2 A-N22)', () => {
  it('[ADR-025] the renderer turns click-through on over transparent corners and off over the island, sending only on change', () => {
    const sent: { ignore: boolean }[] = []
    const clickThrough = useVetaClickThrough({
      bridge: { setVetaClickThrough: (p) => sent.push(p) },
      overIsland
    })
    clickThrough.pointerMoved(11, 11) // the top-left corner, outside its curve: transparent
    clickThrough.pointerMoved(12, 12) // still transparent: nothing new is sent
    clickThrough.pointerMoved(160, 40) // the island
    clickThrough.pointerMoved(200, 50) // still the island
    clickThrough.pointerMoved(309, 69) // the bottom-right corner
    clickThrough.pointerMoved(30, 30) // back on the island, inside the curve
    expect(sent).toEqual([{ ignore: true }, { ignore: false }, { ignore: true }, { ignore: false }])
  })
})
