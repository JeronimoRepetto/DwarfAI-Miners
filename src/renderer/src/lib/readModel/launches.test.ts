import { describe, expect, it } from 'vitest'
import type { HostFrame, LaunchFailure, LaunchId, LaunchWire, MineId } from '@dwarfai/contracts'
import { applyLaunchFrame, hostLaunchesOf, launchInFlight } from './launches'

const ALPHA = '01920000-0000-7000-8000-00000000a001' as MineId
const FIRST = '01920000-0000-7000-8000-00000000f001' as LaunchId
const SECOND = '01920000-0000-7000-8000-00000000f002' as LaunchId

const FAILURE: LaunchFailure = {
  cause: 'not-installed',
  supplierLabel: 'Codex',
  actions: ['pick-manually']
}

function launch(launchId: LaunchId, overrides: Partial<LaunchWire> = {}): LaunchWire {
  return {
    launchId,
    mineId: ALPHA,
    state: 'resolving',
    wayKind: 'supplier',
    requestedAt: 1,
    ...overrides
  } as LaunchWire
}

function frame(name: string, data: unknown): HostFrame {
  return { type: 'evt', seq: 1, epoch: 'epoch-1', name, data } as HostFrame
}

describe('launch folds', () => {
  it('[ADR-020] a snapshot launch carries the failure its wire states', () => {
    const launches = hostLaunchesOf([
      {
        section: 'launches',
        data: [launch(FIRST), launch(SECOND, { state: 'failed', failure: FAILURE })]
      }
    ])
    expect(launches.get(FIRST)).toEqual({
      launchId: FIRST,
      mineId: ALPHA,
      wire: launch(FIRST),
      failure: null
    })
    expect(launches.get(SECOND)?.failure).toEqual(FAILURE)
  })

  it('[NFR-TIM-07] only routing, resolving and spawned with no failure are in flight', () => {
    const states: LaunchWire['state'][] = [
      'routing',
      'resolving',
      'spawned',
      'succeeded',
      'failed',
      'handed-back',
      'lost'
    ]
    expect(
      states.map((state) =>
        launchInFlight({
          launchId: FIRST,
          mineId: ALPHA,
          wire: launch(FIRST, { state }),
          failure: null
        })
      )
    ).toEqual([true, true, true, false, false, false, false])
    expect(
      launchInFlight({ launchId: FIRST, mineId: ALPHA, wire: launch(FIRST), failure: FAILURE })
    ).toBe(false)
    expect(launchInFlight({ launchId: FIRST, mineId: ALPHA, wire: null, failure: null })).toBe(
      false
    )
  })

  it('[ADR-020] launch.failed for a launch the window does not hold keeps no invented wire', () => {
    const launches = hostLaunchesOf([])
    applyLaunchFrame(
      launches,
      frame('launch.failed', { launchId: FIRST, mineId: ALPHA, failure: FAILURE })
    )
    applyLaunchFrame(launches, frame('launch.changed', { launch: { launchId: SECOND } }))
    expect([...launches.values()]).toEqual([
      { launchId: FIRST, mineId: ALPHA, wire: null, failure: FAILURE }
    ])
  })
})
