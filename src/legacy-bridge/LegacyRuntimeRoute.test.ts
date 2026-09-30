// layer: L2
import { describe, expect, it } from 'vitest'
import { FakePanelWindowController } from '../ui-main/window/ports/fakes/FakePanelWindowController'
import {
  createLegacyRuntimeRoute,
  type LegacyHandler,
  type LegacyRuntimeComposer
} from './LegacyRuntimeRoute'

/**
 * `LegacyRuntimeRoute` (21 §3): the one door from the new Electron root to today's runtime. The
 * composition itself is today's code; this pins the door: composed once, and a `legacy` row answered
 * with today's handler result, unchanged.
 */
describe('LegacyRuntimeRoute (21 §3)', () => {
  /** A stand-in for today's composition that counts how many times it was composed. */
  function countingComposer(handlers: Record<string, LegacyHandler>) {
    const counts = { composed: 0, beforeQuit: 0, willQuit: 0 }
    const panelWindow = new FakePanelWindowController({ visible: false })
    const composer: LegacyRuntimeComposer = {
      async compose() {
        counts.composed += 1
        return { handlers: new Map(Object.entries(handlers)), panelWindow }
      },
      beforeQuit() {
        counts.beforeQuit += 1
      },
      willQuit() {
        counts.willQuit += 1
      }
    }
    return { composer, counts, panelWindow }
  }

  it("[ADR-001] LegacyRuntimeRoute composes the legacy runtime once and answers a legacy row with today's handler result", async () => {
    const todaysMines = { mines: [], tokensObserved: 0 }
    const received: unknown[] = []
    const { composer, counts, panelWindow } = countingComposer({
      'mines:get': () => todaysMines,
      'dwarf:kick': async (payload) => {
        received.push(payload)
        return { delivered: false, via: 'none', error: 'The kick could not be delivered.' }
      }
    })
    const route = createLegacyRuntimeRoute(composer)

    const composed = await route.compose()
    const again = await route.compose()
    const mines = await route.serve('mines:get', undefined)
    const kick = await route.serve('dwarf:kick', { dwarfId: 'd-1' })

    expect(counts.composed).toBe(1)
    expect(composed).toBe(panelWindow)
    expect(again).toBe(panelWindow)
    expect(mines).toBe(todaysMines)
    expect(kick).toEqual({
      delivered: false,
      via: 'none',
      error: 'The kick could not be delivered.'
    })
    expect(received).toEqual([{ dwarfId: 'd-1' }])
  })

  it('[ADR-001] LegacyRuntimeRoute composes the legacy runtime on the first served row when it was not composed yet, and only once', async () => {
    const { composer, counts } = countingComposer({ 'app:build': () => 'today' })
    const route = createLegacyRuntimeRoute(composer)

    const answers = await Promise.all([
      route.serve('app:build', undefined),
      route.serve('app:build', undefined),
      route.compose()
    ])

    expect(counts.composed).toBe(1)
    expect(answers.slice(0, 2)).toEqual(['today', 'today'])
  })

  it('[ADR-001] LegacyRuntimeRoute refuses a row that today’s runtime has no handler for', async () => {
    const { composer } = countingComposer({ 'mines:get': () => [] })
    const route = createLegacyRuntimeRoute(composer)

    await expect(route.serve('panel:visible:changed', undefined)).rejects.toThrow(
      'LegacyRuntimeRoute: no legacy handler for panel:visible:changed'
    )
  })

  it('[ADR-001] LegacyRuntimeRoute hands every app quit to today’s teardown, also while the runtime is still being composed', async () => {
    const { composer, counts } = countingComposer({})
    const route = createLegacyRuntimeRoute(composer)

    const composing = route.compose()
    route.beforeQuit()
    route.willQuit()
    await composing
    route.beforeQuit()
    route.willQuit()

    expect(counts).toEqual({ composed: 1, beforeQuit: 2, willQuit: 2 })
  })
})
