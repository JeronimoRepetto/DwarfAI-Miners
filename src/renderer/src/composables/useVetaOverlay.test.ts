import type { VetaLayoutRequest, VetaLayoutResult } from '@dwarfai/contracts'
import { describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { useVetaOverlay } from './useVetaOverlay'

/*
 * ISSUE-288 (TC-288-04; ADR-025 item 2; 14 §2.2 A-N23 `layoutVeta {overlay}`): an overlay of the Veta window (the grip
 * menu, the mine picker) shows only once UI main has grown the window for it, and the window shrinks back only once the
 * overlay is gone. A fake bridge stands in for UI main and records what is asked and when the overlay showed.
 */

const PLACE: VetaLayoutResult = {
  applied: true,
  displayKey: 'Q27G2WG4|2560x1440|@1|0,0',
  dock: { edge: 'bottom', end: 'end', offset: 16 }
}

function world() {
  const log: string[] = []
  const pending: Array<() => void> = []
  const overlay = useVetaOverlay({
    bridge: {
      layoutVeta(request: VetaLayoutRequest) {
        log.push(JSON.stringify(request))
        return new Promise((resolve) => pending.push(() => resolve(PLACE)))
      }
    }
  })
  /** UI main answers every request asked so far. */
  async function answer(): Promise<void> {
    for (const resolve of pending.splice(0)) resolve()
    await nextTick()
    await Promise.resolve()
  }
  return { overlay, log, answer }
}

describe('useVetaOverlay', () => {
  it('[ADR-025, S22.01, S22.16] an overlay shows only once the window has grown, and the window shrinks only once it is gone', async () => {
    const { overlay, log, answer } = world()
    const opened = overlay.open({ width: 320, height: 300 })
    // Asked, not answered yet: the overlay does not show in a window too small for it.
    expect(log).toEqual(['{"kind":"overlay","bounds":{"width":320,"height":300}}'])
    expect(overlay.shown.value).toBe(false)
    await answer()
    await opened
    expect(overlay.shown.value).toBe(true)

    // Another overlay replaces it (the menu, then the picker): the window grows for the new one first.
    const replaced = overlay.open({ width: 200, height: 160 })
    expect(overlay.shown.value).toBe(true)
    await answer()
    await replaced
    expect(log.at(-1)).toBe('{"kind":"overlay","bounds":{"width":200,"height":160}}')

    // Closed: hidden first, and the shrink is asked only after the overlay has left the page.
    const closing = overlay.close()
    expect(overlay.shown.value).toBe(false)
    expect(log).toHaveLength(2)
    await nextTick()
    expect(log.at(-1)).toBe('{"kind":"overlay","bounds":null}')
    await answer()
    await closing
  })

  it('[S22.17] a drag drops an open overlay without asking for a shrink, and a late answer never shows a closed one', async () => {
    const { overlay, log, answer } = world()
    const opened = overlay.open({ width: 320, height: 300 })
    // Closed before UI main answered the growth: the answer must not bring it back.
    const closing = overlay.close()
    // UI main answers the growth, then the shrink asked once the overlay left the page.
    await answer()
    await answer()
    await opened
    await closing
    expect(overlay.shown.value).toBe(false)
    expect(log.at(-1)).toBe('{"kind":"overlay","bounds":null}')

    const again = overlay.open({ width: 200, height: 160 })
    await answer()
    await again
    expect(overlay.shown.value).toBe(true)
    const asked = log.length
    // The drag surface replaced the window (UI main forgot the overlay): nothing more is asked.
    overlay.drop()
    await answer()
    expect(overlay.shown.value).toBe(false)
    expect(log).toHaveLength(asked)
  })
})
