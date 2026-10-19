import { describe, expect, it } from 'vitest'
import type { LaunchFailureCause } from '../../../kernel/domain/sharedContracts'
import type {
  DwarfId,
  HostEpoch,
  LaunchId,
  MineId,
  ProviderId
} from '../../../kernel/domain/values'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import {
  applyLaunchEvent,
  requestLaunch,
  type Launch,
  type LaunchEvent,
  type LaunchRequest,
  type LaunchState,
  type LaunchTransitionId
} from './launch'
import { buildLaunchFailure } from './launchFailure'

const EPOCH: HostEpoch = 'epoch-1'
const DWARF = 'dwarf-1' as DwarfId
const CAUSES: readonly LaunchFailureCause[] = [
  'not-installed',
  'exited-at-once',
  'could-not-start',
  'jev-unreachable',
  'jev-could-not-choose'
]

function request(overrides: Partial<LaunchRequest> = {}): LaunchRequest {
  return {
    mineId: 'mine-1' as MineId,
    way: { kind: 'supplier', providerId: 'codex' },
    model: 'gpt-5',
    effort: 'high',
    permissionMode: 'ask-first',
    prompt: 'Fix the flaky test',
    jevOn: false,
    jevAutoAccept: false,
    ...overrides
  }
}

function launchIn(state: LaunchState, overrides: Partial<Launch> = {}): Launch {
  return {
    id: 'launch-1' as LaunchId,
    request: request({ jevOn: state === 'routing' }),
    state,
    hostEpoch: EPOCH,
    launchedWithLetJevChoose: state === 'routing',
    ...(state === 'spawned' ? { spawnedAt: 10_000 } : {}),
    ...overrides
  }
}

function failedEvent(cause: LaunchFailureCause): LaunchEvent {
  const jevCause = cause === 'jev-unreachable' || cause === 'jev-could-not-choose'
  return {
    t: 'failed',
    failure: buildLaunchFailure({
      cause,
      supplierLabel: 'Codex',
      ...(jevCause ? { jevReason: 'timeout' as const } : {})
    })
  }
}

const EVENTS: Record<string, LaunchEvent> = {
  'jev-picked': { t: 'jev-picked' },
  'handed-back': { t: 'handed-back' },
  ...Object.fromEntries(CAUSES.map((cause) => [`failed:${cause}`, failedEvent(cause)])),
  spawned: { t: 'spawned', at: 12_000 },
  succeeded: { t: 'succeeded', dwarfId: DWARF },
  'boot:no-evidence': { t: 'boot-reconciled', evidence: null },
  'boot:evidence': { t: 'boot-reconciled', evidence: DWARF },
  'ui:add-panel-closed': { t: 'ui-visibility', what: 'add-panel-closed' },
  'ui:window-closed': { t: 'ui-visibility', what: 'window-closed' },
  'ui:ui-detached': { t: 'ui-visibility', what: 'ui-detached' }
}

type Row = readonly [LaunchState, LaunchTransitionId]

function unchanged(state: LaunchState): Record<string, Row> {
  return {
    'ui:add-panel-closed': [state, 'S5.24'],
    'ui:window-closed': [state, 'S5.24'],
    'ui:ui-detached': [state, 'S5.24']
  }
}

/** 07 machine 5B, written by hand: state → event → [to, transition id]; anything absent is refused. */
const TABLE: Record<LaunchState, Record<string, Row>> = {
  routing: {
    'jev-picked': ['resolving', 'S5.12'],
    'handed-back': ['handed-back', 'S5.13'],
    'failed:jev-unreachable': ['failed', 'S5.14'],
    'failed:jev-could-not-choose': ['failed', 'S5.15'],
    'boot:no-evidence': ['lost', 'S5.22'],
    ...unchanged('routing')
  },
  resolving: {
    'failed:not-installed': ['failed', 'S5.16'],
    'failed:could-not-start': ['failed', 'S5.17'],
    spawned: ['spawned', 'S5.18'],
    'boot:no-evidence': ['lost', 'S5.22'],
    ...unchanged('resolving')
  },
  spawned: {
    'failed:could-not-start': ['failed', 'S5.19'],
    'failed:exited-at-once': ['failed', 'S5.20'],
    succeeded: ['succeeded', 'S5.21'],
    'boot:no-evidence': ['lost', 'S5.22'],
    'boot:evidence': ['succeeded', 'S5.23'],
    ...unchanged('spawned')
  },
  succeeded: {},
  failed: {},
  'handed-back': {},
  lost: {}
}

describe('Host launch machine 5B', () => {
  it('[S5.10, S5.11, S5.12, S5.13, S5.14, S5.15, S5.16, S5.17, S5.18, S5.19, S5.20, S5.21, S5.22, S5.23, S5.24] every listed transition is reached and every unlisted one is refused', () => {
    const reached = new Set<LaunchTransitionId>()

    const jev = requestLaunch({
      id: 'l-10' as LaunchId,
      request: request({ jevOn: true }),
      hostEpoch: EPOCH
    })
    expect(jev.ok && [jev.value.launch.state, jev.value.via]).toEqual(['routing', 'S5.10'])
    if (jev.ok) reached.add(jev.value.via)
    const supplier = requestLaunch({ id: 'l-11' as LaunchId, request: request(), hostEpoch: EPOCH })
    expect(supplier.ok && [supplier.value.launch.state, supplier.value.via]).toEqual([
      'resolving',
      'S5.11'
    ])
    if (supplier.ok) reached.add(supplier.value.via)

    for (const state of Object.keys(TABLE) as LaunchState[]) {
      for (const [name, event] of Object.entries(EVENTS)) {
        const step = applyLaunchEvent(launchIn(state), event)
        const expected = TABLE[state][name]
        if (expected === undefined) {
          expect(step, `${state} + ${name} must be refused`).toEqual({
            ok: false,
            error: 'transition-refused'
          })
          continue
        }
        expect(step.ok && [step.value.launch.state, step.value.via], `${state} + ${name}`).toEqual(
          expected
        )
        if (step.ok) reached.add(step.value.via)
      }
    }

    expect([...reached].sort()).toEqual(Array.from({ length: 15 }, (_, i) => `S5.${10 + i}`))
  })

  it('[S5.13, INV-52] only a normal launch can be handed back, never a delegated one', () => {
    const delegated = launchIn('routing', {
      request: request({ jevOn: false, delegation: { parentDwarfId: 'p' } }),
      launchedWithLetJevChoose: false
    })

    expect(applyLaunchEvent(delegated, { t: 'handed-back' })).toEqual({
      ok: false,
      error: 'transition-refused'
    })
  })

  it('[S5.12, S5.13] a Jev pick is recorded on resolving and the handed-back picks on handed-back', () => {
    const pick = { providerId: 'simulated' as ProviderId, model: 'sim-small', effort: 'low' }
    const picked = applyLaunchEvent(launchIn('routing'), { t: 'jev-picked', pick })
    expect(picked.ok && picked.value.launch).toMatchObject({ state: 'resolving', pick })

    const picks = { providerId: 'simulated' as ProviderId, model: 'sim-small' }
    const back = applyLaunchEvent(launchIn('routing'), { t: 'handed-back', picks })
    expect(back.ok && back.value.launch).toMatchObject({ state: 'handed-back', picks })
    expect(back.ok && back.value.launch.failure).toBeUndefined()
  })

  it('[S5.18, S5.21, S5.23] spawning records t0 and succeeding records the dwarf', () => {
    const clock = new FakeClock(40_000)
    const spawned = applyLaunchEvent(launchIn('resolving'), { t: 'spawned', at: clock.now() })
    expect(spawned.ok && spawned.value.launch.spawnedAt).toBe(40_000)

    const ok = applyLaunchEvent(launchIn('spawned'), { t: 'succeeded', dwarfId: DWARF })
    expect(ok.ok && ok.value.launch.dwarfId).toBe(DWARF)
    const recovered = applyLaunchEvent(launchIn('spawned'), {
      t: 'boot-reconciled',
      evidence: DWARF
    })
    expect(recovered.ok && recovered.value.launch.dwarfId).toBe(DWARF)
  })

  it('[INV-50] a request with an empty prompt or an empty custom command is not sendable', () => {
    for (const bad of [
      request({ prompt: '' }),
      request({ prompt: '   ' }),
      request({ way: { kind: 'custom', command: { raw: '  ', argv: [] } } })
    ]) {
      expect(requestLaunch({ id: 'l' as LaunchId, request: bad, hostEpoch: EPOCH })).toEqual({
        ok: false,
        error: 'not-sendable'
      })
    }
  })

  it('[S5.10] a delegated worker enters routing and is never launched with Let Jev choose', () => {
    const step = requestLaunch({
      id: 'l' as LaunchId,
      request: request({ jevOn: false, delegation: { parentDwarfId: 'p' } }),
      hostEpoch: EPOCH
    })

    expect(step.ok && step.value.launch.state).toBe('routing')
    expect(step.ok && step.value.launch.launchedWithLetJevChoose).toBe(false)
    const jev = requestLaunch({
      id: 'l' as LaunchId,
      request: request({ jevOn: true }),
      hostEpoch: EPOCH
    })
    expect(jev.ok && jev.value.launch.launchedWithLetJevChoose).toBe(true)
  })

  it('[US-LAUNCH-006.AC01, INV-52] a failed launch has exactly one of the five causes and keeps its request unchanged', () => {
    const from: Record<LaunchFailureCause, LaunchState> = {
      'not-installed': 'resolving',
      'could-not-start': 'resolving',
      'exited-at-once': 'spawned',
      'jev-unreachable': 'routing',
      'jev-could-not-choose': 'routing'
    }
    for (const cause of CAUSES) {
      const before = launchIn(from[cause])
      const snapshot = structuredClone(before.request)
      const step = applyLaunchEvent(before, failedEvent(cause))

      expect(step.ok, cause).toBe(true)
      if (!step.ok) continue
      expect(step.value.launch.state).toBe('failed')
      expect(step.value.launch.failure?.cause).toBe(cause)
      expect(step.value.launch.request).toBe(before.request)
      expect(step.value.launch.request).toEqual(snapshot)
    }
  })

  it('[US-LAUNCH-006.AC05, INV-52] every cause yields a LaunchFailure the notice can render, and handed-back and lost yield none', () => {
    const from: Record<LaunchFailureCause, LaunchState> = {
      'not-installed': 'resolving',
      'could-not-start': 'spawned',
      'exited-at-once': 'spawned',
      'jev-unreachable': 'routing',
      'jev-could-not-choose': 'routing'
    }
    for (const cause of CAUSES) {
      const step = applyLaunchEvent(launchIn(from[cause]), failedEvent(cause))
      const failure = step.ok ? step.value.launch.failure : undefined

      expect(failure, cause).toMatchObject({ cause, supplierLabel: 'Codex' })
      expect(failure?.actions.length, cause).toBeGreaterThan(0)
    }

    const handedBack = applyLaunchEvent(launchIn('routing'), { t: 'handed-back' })
    expect(handedBack.ok && handedBack.value.launch.state).toBe('handed-back')
    expect(handedBack.ok && handedBack.value.launch).not.toHaveProperty('failure')
    for (const state of ['routing', 'resolving', 'spawned'] as const) {
      const lost = applyLaunchEvent(launchIn(state), { t: 'boot-reconciled', evidence: null })
      expect(lost.ok && lost.value.launch.state).toBe('lost')
      expect(lost.ok && lost.value.launch).not.toHaveProperty('failure')
    }
  })

  it('[NFR-TIM-07, S5.24] closing the Add panel, the window or detaching the UI changes no launch state', () => {
    for (const state of ['routing', 'resolving', 'spawned'] as const) {
      for (const what of ['add-panel-closed', 'window-closed', 'ui-detached'] as const) {
        const before = launchIn(state)
        const step = applyLaunchEvent(before, { t: 'ui-visibility', what })

        expect(step.ok && step.value.launch).toBe(before)
        expect(step.ok && step.value.via).toBe('S5.24')
      }
    }
  })
})
