// layer: L1
import { describe, expect, it } from 'vitest'
import type { LaunchId, LaunchWire, MineId } from '@dwarfai/contracts'
import { DEFAULT_JEV_PREFERENCES, type JevSettings } from '../../types'
import type { HostLaunch } from '../readModel/launches'
import {
  chooseEffort,
  chooseModel,
  chooseProvider,
  closedLaunch,
  hostLaunchAccepted,
  hostLaunchFollowed,
  launchFailed,
  launchParamsOf,
  openLaunch,
  OTHER_CHOICE,
  setJevSettings,
  submitStarted,
  toggleJev,
  typePrompt,
  unstatedLaunchTimedOut,
  DETACHED_TIMEOUT_MESSAGE,
  type LaunchState
} from './launchState'

// ISSUE-001 (the ISSUE-179 call side): from 3a A-35 has its 14 shape for every provider (21 §2 cut 3 common rules),
// `LaunchParams` → `IpcResult<LaunchAccepted>`, and a launch the Host owns settles only on its `launch.changed` /
// `launch.failed` (07 5A `sending`: "until the Host's start or failure event, no client timer"; NFR-TIM-07).

const MINE = '01900000-0000-7000-8000-000000000101' as MineId
const REQUEST = '01900000-0000-7000-8000-000000000102'
const LAUNCH = '01900000-0000-7000-8000-000000000103' as LaunchId
const FAILED = '01900000-0000-7000-8000-000000000104' as LaunchId
const DWARF = '01900000-0000-7000-8000-000000000105'
const READY: JevSettings = { configured: true, preferences: DEFAULT_JEV_PREFERENCES }

function ready(provider: 'claude' | 'codex' = 'claude'): LaunchState {
  return typePrompt(chooseProvider(openLaunch(closedLaunch()), provider), '  map the build  ')
}

function wire(state: LaunchWire['state'], extra: Partial<LaunchWire> = {}): LaunchWire {
  return {
    launchId: LAUNCH,
    mineId: MINE,
    state,
    wayKind: 'supplier',
    requestedAt: 1,
    ...extra
  }
}

function launch(launchWire: LaunchWire | null, failure: HostLaunch['failure'] = null): HostLaunch {
  return { launchId: LAUNCH, mineId: MINE, wire: launchWire, failure }
}

describe('A-35 in its 14 shape (ISSUE-001)', () => {
  it('[ADR-020] a supplier launch carries the 14 LaunchParams, the tuning only where the person chose it', () => {
    expect(launchParamsOf(ready(), MINE, REQUEST)).toEqual({
      mineId: MINE,
      way: { kind: 'supplier', providerId: 'claude' },
      prompt: 'map the build',
      jevOn: false,
      jevAutoAccept: false,
      requestId: REQUEST
    })
    const tuned = chooseEffort(chooseModel(ready('codex'), 'gpt-5'), 'high')
    expect(launchParamsOf(tuned, MINE, REQUEST, FAILED)).toMatchObject({
      way: { kind: 'supplier', providerId: 'codex' },
      model: 'gpt-5',
      effort: 'high',
      retryOf: FAILED
    })
    // Other… is a custom command (A-39), never an A-35 launch.
    expect(launchParamsOf({ ...ready(), choice: OTHER_CHOICE }, MINE, REQUEST)).toBeNull()
  })

  it('[US-LAUNCH-003.AC02] with Let Jev choose on the launch is the Host Jev way, its switches carried', () => {
    const jev = toggleJev(setJevSettings(ready(), READY))
    expect(launchParamsOf(jev, MINE, REQUEST)).toMatchObject({
      way: { kind: 'jev' },
      jevOn: true,
      jevAutoAccept: false
    })
  })

  it('[NFR-TIM-07] an accepted launch stays sending until the Host states it, and is adopted only on its success', () => {
    const sending = hostLaunchAccepted(submitStarted(ready()), LAUNCH)
    expect(sending.submitting).toBe(true)
    expect(sending.launchId).toBe(LAUNCH)
    // In flight, or a frame for another launch: nothing changes.
    expect(hostLaunchFollowed(sending, launch(wire('spawned')))).toEqual(sending)
    expect(hostLaunchFollowed(sending, { ...launch(wire('succeeded')), launchId: FAILED })).toEqual(
      sending
    )
    const adopted = hostLaunchFollowed(
      sending,
      launch(wire('succeeded', { dwarfId: DWARF as never }))
    )
    expect(adopted.launchedDwarfId).toBe(DWARF)
    expect(adopted.submitting).toBe(false)
  })

  it('[ADR-020] a launch.failed frame puts the failure with its cause and tail into the state', () => {
    const sending = hostLaunchAccepted(submitStarted(ready()), LAUNCH)
    const failed = hostLaunchFollowed(
      sending,
      launch(wire('spawned'), {
        cause: 'exited-at-once',
        supplierLabel: 'Claude Code',
        actions: ['retry'],
        toolOutputTail: 'auth required'
      })
    )
    expect(failed.submitting).toBe(false)
    expect(failed.failure).toEqual({
      cause: 'exited-at-once',
      choice: 'claude',
      output: 'auth required'
    })
    // The failed launch is what a Retry names (`retryOf`).
    expect(failed.launchId).toBe(LAUNCH)
    const jev = hostLaunchFollowed(
      sending,
      launch(null, {
        cause: 'jev-could-not-choose',
        supplierLabel: 'Jev',
        jevReason: 'no-launchable-provider',
        actions: []
      })
    )
    expect(jev.failure).toEqual({ cause: 'jev-could-not-choose', reason: 'no-launchable-provider' })
  })

  it('[ADR-020] a handed-back launch is ready again with the picks in the pickers and no notice', () => {
    const sending = hostLaunchAccepted(
      submitStarted(toggleJev(setJevSettings(ready(), READY))),
      LAUNCH
    )
    const back = hostLaunchFollowed(
      sending,
      launch(
        wire('handed-back', {
          picks: { providerId: 'codex' as never, model: 'gpt-5', effort: 'low' }
        })
      )
    )
    expect(back.submitting).toBe(false)
    expect(back.failure).toBeNull()
    expect([back.choice, back.model, back.effort]).toEqual(['codex', 'gpt-5', 'low'])
  })

  it("[ADR-020] a launch the Host never stated settles on today's A-P3 under its LaunchId, or on today's bound", () => {
    // A provider not yet moved: `PerProviderShapeAdapter` answered a minted LaunchId, today's A-P3 names it.
    const sending = hostLaunchAccepted(submitStarted(ready('codex')), LAUNCH)
    const failed = launchFailed(sending, {
      launchId: LAUNCH,
      provider: 'codex',
      mineId: MINE,
      exitCode: 1,
      stderrTail: '',
      cause: 'not-installed'
    })
    expect(failed.submitting).toBe(false)
    expect(failed.failure).toEqual({ cause: 'not-installed', choice: 'codex' })
    // The bound acts only for a launch the Host never stated (NFR-TIM-07 for the Host's own).
    expect(unstatedLaunchTimedOut(sending, LAUNCH, true)).toEqual(sending)
    expect(unstatedLaunchTimedOut(sending, FAILED, false)).toEqual(sending)
    const timedOut = unstatedLaunchTimedOut(sending, LAUNCH, false)
    expect(timedOut.submitting).toBe(false)
    expect(timedOut.error).toBe(DETACHED_TIMEOUT_MESSAGE)
  })
})
