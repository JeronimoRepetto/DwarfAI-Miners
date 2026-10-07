// layer: L2
import { describe, expect, it } from 'vitest'
import { FakePanelWindowController } from '../ui-main/window/ports/fakes/FakePanelWindowController'
import type { LegacyLaunchedSessions, LegacyLaunchesByDwarf } from './LegacyEndFirstAdapter'
import type { LegacyBoardSource } from './LegacyRuntimeSurface'
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
  function countingComposer(
    handlers: Record<string, LegacyHandler>,
    // AMENDED for ISSUE-091 (was: `LegacyLaunchedSessions` only): the register also answers which launch started a
    // legacy dwarf (`LegacyLaunchesByDwarf`, the A-32 half of LegacyEndFirstAdapter, ISSUE-090).
    launches: LegacyLaunchedSessions & LegacyLaunchesByDwarf = {
      liveLaunches: async () => [],
      endLaunch: async () => 'already-ended',
      launchIdOfDwarf: () => undefined
    },
    // AMENDED for ISSUE-123 stage (a) (was: no board): the composition also hands over today's board as one tick of
    // today's poll leaves it, for the production `LegacyRuntimeSurface`; none of the cases above reads it.
    board: LegacyBoardSource = {
      pollIntervalMs: 2_000,
      refresh: async () => {},
      current: () => []
    }
  ) {
    const counts = { composed: 0, beforeQuit: 0, willQuit: 0 }
    const panelWindow = new FakePanelWindowController({ visible: false })
    const composer: LegacyRuntimeComposer = {
      async compose() {
        counts.composed += 1
        return { handlers: new Map(Object.entries(handlers)), panelWindow, launches, board }
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

  it('[ADR-001] LegacyRuntimeRoute reaches today’s launched register for LegacyEndFirstAdapter, composing the runtime once first', async () => {
    const ended: string[] = []
    const { composer, counts } = countingComposer(
      {},
      {
        liveLaunches: async () => [{ launchId: 'launch:1' }],
        endLaunch: async (launchId) => {
          ended.push(launchId)
          return 'ended'
        },
        // AMENDED for ISSUE-091: the widened register (see `countingComposer`).
        launchIdOfDwarf: () => undefined
      }
    )
    const route = createLegacyRuntimeRoute(composer)

    const live = await route.liveLaunches()
    const verdict = await route.endLaunch('launch:1')

    expect(counts.composed).toBe(1)
    expect(live).toEqual([{ launchId: 'launch:1' }])
    expect(verdict).toBe('ended')
    expect(ended).toEqual(['launch:1'])
  })

  it('[ADR-001] LegacyRuntimeRoute answers which launch started a legacy dwarf from today’s register, and none before the runtime is composed', async () => {
    const { composer, counts } = countingComposer(
      {},
      {
        liveLaunches: async () => [{ launchId: 'launch:7' }],
        endLaunch: async () => 'ended',
        launchIdOfDwarf: (dwarfId) => (dwarfId === 'codex:thread-7' ? 'launch:7' : undefined)
      }
    )
    const route = createLegacyRuntimeRoute(composer)

    // Nothing composed: today's runtime launched nothing yet, so no dwarf has a launch, and asking composes nothing.
    expect(route.launchIdOfDwarf('codex:thread-7')).toBeUndefined()
    expect(counts.composed).toBe(0)

    await route.compose()

    expect(route.launchIdOfDwarf('codex:thread-7')).toBe('launch:7')
    expect(route.launchIdOfDwarf('codex:someone-else')).toBeUndefined()
    expect(counts.composed).toBe(1)
  })

  it('[ADR-001] LegacyRuntimeRoute hands LegacyAgentRegistryFeed today’s composed board: a discovery cycle composes the runtime once and runs one tick of it', async () => {
    // ISSUE-123 stage (a) (21 §3 `LegacyAgentRegistryFeed`; lead resolution H2): the production `LegacyRuntimeSurface`.
    let ticks = 0
    const { composer, counts } = countingComposer({}, undefined, {
      pollIntervalMs: 1_500,
      refresh: async () => {
        ticks += 1
      },
      current: () => [
        {
          id: 'mine-1',
          path: '/work/moria',
          name: 'moria',
          tier: 'bronze',
          tokensObserved: 0,
          updatedAt: 3,
          dwarfs: [
            {
              id: 'claude:s-1',
              provider: 'claude',
              role: 'foreman',
              name: 'Thorin',
              status: 'working',
              sessionId: 's-1'
            }
          ]
        }
      ]
    })
    const route = createLegacyRuntimeRoute(composer)

    // Nothing composed yet: the feed starts only after today's runtime is composed, so its interval is not known.
    expect(() => route.surface.pollIntervalMs).toThrow(/before today’s runtime is composed/)
    const [claude, codex] = await Promise.all([
      route.surface.discovery.find((p) => p.kind === 'claude')?.scan(),
      route.surface.discovery.find((p) => p.kind === 'codex')?.scan()
    ])

    expect(counts.composed).toBe(1)
    expect(ticks).toBe(1)
    expect(route.surface.pollIntervalMs).toBe(1_500)
    expect(claude?.map((session) => [session.provider, session.sessionId])).toEqual([
      ['claude', 's-1']
    ])
    expect(codex).toEqual([])
  })
})
