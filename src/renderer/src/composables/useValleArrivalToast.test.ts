import type { MineId, MineWire } from '@dwarfai/contracts'
import { describe, expect, it } from 'vitest'
import { effectScope, shallowRef } from 'vue'
import type { ValleFact } from '../lib/valle/valleReadModel'
import { DAIN, EREBOR, MORIA, NALI, dwarfWire, mineWire } from '../lib/veta/testing/vetaFixtures'
import { useValleArrivalToast } from './useValleArrivalToast'

/**
 * The "started in" toast in Valle (07 S39.11; US-VETA-007.AC05, Valle's half; PO #48; BR-23): an observed arrival in a
 * known mine that is not on screen in Valle raises the window's one toast; one on screen, a re-snapshot or a hidden Valle
 * raises none.
 */
function world() {
  const listeners = new Set<(facts: readonly ValleFact[]) => void>()
  const toasts: string[] = []
  const onScreen = shallowRef<readonly MineId[]>([MORIA])
  const shown = shallowRef(true)
  const mines = shallowRef<readonly MineWire[]>([mineWire(MORIA), mineWire(EREBOR)])
  const scope = effectScope()
  scope.run(() =>
    useValleArrivalToast({
      facts: {
        mines,
        onFacts(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        }
      },
      onScreen: () => onScreen.value,
      shown: () => shown.value,
      showToast: (text) => toasts.push(text)
    })
  )
  const hear = (facts: ValleFact[]): void => {
    for (const listener of [...listeners]) listener(facts)
  }
  return { toasts, onScreen, shown, hear, scope, listeners }
}

describe('the started-in toast in Valle (07 S39.11; ISSUE-299)', () => {
  it('[S39.11, US-VETA-007.AC05] an observed arrival in a mine not on screen in Valle shows the started-in toast', () => {
    const w = world()
    // On screen: the person sees the dwarf arrive, so no toast.
    w.hear([{ kind: 'arrived', dwarf: dwarfWire(NALI, MORIA), announce: true }])
    expect(w.toasts).toEqual([])
    // Not on screen (scrolled out, another preset's mine): the toast, in the Panel's own words.
    w.hear([{ kind: 'arrived', dwarf: dwarfWire(DAIN, EREBOR), announce: true }])
    expect(w.toasts).toEqual(['dain started in erebor'])
    // A custom name wins over the base name.
    w.hear([
      {
        kind: 'arrived',
        dwarf: dwarfWire(DAIN, EREBOR, { customName: 'Old Dain' }),
        announce: true
      }
    ])
    expect(w.toasts.at(-1)).toBe('Old Dain started in erebor')
    const count = w.toasts.length
    // Not announced by the Host, a mine Valle does not know, a re-snapshot, or Valle hidden: no toast.
    w.hear([{ kind: 'arrived', dwarf: dwarfWire(NALI, EREBOR), announce: false }])
    w.hear([
      {
        kind: 'arrived',
        dwarf: dwarfWire(NALI, '01920000-0000-7000-8000-00000000a0ff' as MineId),
        announce: true
      }
    ])
    w.hear([{ kind: 'snapshot' }])
    w.shown.value = false
    w.hear([{ kind: 'arrived', dwarf: dwarfWire(NALI, EREBOR), announce: true }])
    expect(w.toasts).toHaveLength(count)
    w.scope.stop()
    expect(w.listeners.size).toBe(0)
  })
})
