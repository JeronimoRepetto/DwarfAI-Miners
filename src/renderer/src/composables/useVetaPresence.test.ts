import type { MineId } from '@dwarfai/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import { EREBOR, KHAZAD, MORIA } from '../lib/veta/testing/vetaFixtures'
import type { VetaLifeState } from '../lib/veta/lifeState'
import { useVetaPresence, type VetaPresenceFacts } from './useVetaPresence'

/*
 * ISSUE-287 (TC-287-03): Veta reports the mines whose chamber is drawn (A-44 `reportVisibleMines`), so UI main's
 * PresenceTracker knows what is on screen (ADR-024 item 7; INV-119). A folded or undrawn mine is not on screen (BR-02).
 */
describe('useVetaPresence', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('[S20.18, BR-02, ADR-024] reportVisibleMines carries the mines whose chamber is drawn, debounced 100 ms, and is empty in first-run, no-sessions and while hidden', async () => {
    const reports: MineId[][] = []
    const facts = ref<VetaPresenceFacts>({
      state: 'sessions-working',
      shown: true,
      drawn: [MORIA, EREBOR]
    })
    const scope = effectScope()
    scope.run(() =>
      useVetaPresence({
        bridge: { reportVisibleMines: ({ mineIds }) => reports.push([...mineIds]) },
        facts: () => facts.value
      })
    )
    const set = async (next: Partial<VetaPresenceFacts>): Promise<void> => {
      facts.value = { ...facts.value, ...next }
      await nextTick()
    }

    // Debounced: nothing before 100 ms of quiet, then the drawn chambers.
    vi.advanceTimersByTime(99)
    expect(reports).toEqual([])
    vi.advanceTimersByTime(1)
    expect(reports).toEqual([[MORIA, EREBOR]])

    // Two changes inside 100 ms send once, the last.
    await set({ drawn: [MORIA, EREBOR, KHAZAD] })
    vi.advanceTimersByTime(50)
    await set({ drawn: [MORIA, KHAZAD] })
    vi.advanceTimersByTime(99)
    expect(reports).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(reports.at(-1)).toEqual([MORIA, KHAZAD])

    // Hidden: nothing is on screen.
    await set({ shown: false })
    vi.advanceTimersByTime(100)
    expect(reports.at(-1)).toEqual([])

    // Shown again in all idle: every chamber drawn.
    await set({ shown: true, state: 'all-idle', drawn: [EREBOR] })
    vi.advanceTimersByTime(100)
    expect(reports.at(-1)).toEqual([EREBOR])

    // The closed entrance draws no chamber, whatever is passed as drawn.
    const closed: VetaLifeState[] = ['no-sessions', 'first-run']
    for (const state of closed) {
      await set({ state: 'all-idle', drawn: [MORIA] })
      vi.advanceTimersByTime(100)
      expect(reports.at(-1)).toEqual([MORIA])
      await set({ state })
      vi.advanceTimersByTime(100)
      expect(reports.at(-1), state).toEqual([])
    }

    // An unchanged set is not sent again.
    const sent = reports.length
    await set({ drawn: [] })
    vi.advanceTimersByTime(200)
    expect(reports).toHaveLength(sent)

    scope.stop()
  })
})
