// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { useVetaClickThrough, vetaTakesPointer } from './useVetaClickThrough'

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

  it('[US-VETA-004.AC02, ADR-025] the tab band is click-through except over a risen tab', () => {
    // The Veta window as the root draws it: the island with a chamber and its tab, the open overlay's card, and the
    // transparent room around them (the tab band, the overlay's gap).
    document.body.innerHTML = `
      <div data-veta-root>
        <div data-veta-island>
          <div data-veta-chamber data-mine-id="a">
            <span data-veta-dwarf></span>
            <div data-veta-tab data-risen="false"><button data-tab-open></button></div>
          </div>
          <div data-veta-chamber data-mine-id="b">
            <div data-veta-tab data-risen="true"><button data-tab-open></button></div>
          </div>
        </div>
        <div data-veta-overlay><div data-veta-overlay-card><button></button></div></div>
      </div>`
    const at = (selector: string): Element => document.querySelector(selector)!
    // The band and the overlay's room are transparent: the mouse goes through.
    expect(vetaTakesPointer(at('[data-veta-root]'))).toBe(false)
    expect(vetaTakesPointer(at('[data-veta-overlay]'))).toBe(false)
    expect(vetaTakesPointer(null)).toBe(false)
    // A folded tab, even caught mid-fade, is part of the band.
    expect(vetaTakesPointer(at('[data-mine-id="a"] [data-tab-open]'))).toBe(false)
    // The island, a risen tab and the overlay's card take it.
    expect(vetaTakesPointer(at('[data-veta-dwarf]'))).toBe(true)
    expect(vetaTakesPointer(at('[data-mine-id="b"] [data-tab-open]'))).toBe(true)
    expect(vetaTakesPointer(at('[data-veta-overlay-card] button'))).toBe(true)
    document.body.innerHTML = ''
  })

  it('[S24.01, ADR-025] the risen chat takes the pointer, and its gap to the strip lets it through', () => {
    document.body.innerHTML = `
      <div data-veta-root>
        <div data-veta-island><span data-veta-dwarf></span></div>
        <div data-veta-risen><section class="dm-msg"><textarea></textarea></section></div>
      </div>`
    const at = (selector: string): Element => document.querySelector(selector)!
    expect(vetaTakesPointer(at('[data-veta-risen] textarea'))).toBe(true)
    expect(vetaTakesPointer(at('[data-veta-risen]'))).toBe(true)
    // The gap between the risen window and the strip is the window's transparent room.
    expect(vetaTakesPointer(at('[data-veta-root]'))).toBe(false)
    document.body.innerHTML = ''
  })
})
