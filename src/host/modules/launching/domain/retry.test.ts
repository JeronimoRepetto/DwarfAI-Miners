import { describe, expect, it } from 'vitest'
import type { LaunchFailureCause } from '../../../kernel/domain/sharedContracts'
import type { HostEpoch, LaunchId, MineId } from '../../../kernel/domain/values'
import type { Launch, LaunchRequest } from './launch'
import { buildLaunchFailure } from './launchFailure'
import { retryLaunch } from './retry'

function failedLaunch(cause: LaunchFailureCause, request: LaunchRequest): Launch {
  return {
    id: 'launch-1' as LaunchId,
    request,
    state: 'failed',
    failure: buildLaunchFailure({ cause, supplierLabel: 'Codex', jevReason: 'timeout' }),
    hostEpoch: 'epoch-1' as HostEpoch,
    launchedWithLetJevChoose: request.jevOn
  }
}

function request(jevOn: boolean): LaunchRequest {
  return {
    mineId: 'mine-1' as MineId,
    way: jevOn ? { kind: 'jev' } : { kind: 'supplier', providerId: 'codex' },
    model: 'gpt-5',
    effort: 'high',
    permissionMode: 'ask-first',
    prompt: 'Fix the flaky test',
    jevOn,
    jevAutoAccept: true
  }
}

describe('retryLaunch (ADR-020 item 8)', () => {
  it('[INV-54] retry creates a new launch with the identical request and retryOf, entering routing with Jev on and resolving with Jev off', () => {
    for (const [jevOn, entry, via] of [
      [true, 'routing', 'S5.10'],
      [false, 'resolving', 'S5.11']
    ] as const) {
      const failed = failedLaunch('exited-at-once', request(jevOn))
      const snapshot = structuredClone(failed)
      const step = retryLaunch(failed, { id: 'launch-2' as LaunchId, hostEpoch: 'epoch-2' })

      expect(step.ok).toBe(true)
      if (!step.ok) continue
      expect(step.value.launch).toEqual({
        id: 'launch-2',
        request: failed.request,
        state: entry,
        retryOf: 'launch-1',
        hostEpoch: 'epoch-2',
        launchedWithLetJevChoose: jevOn
      })
      expect(step.value.launch.request).toBe(failed.request)
      expect(step.value.via).toBe(via)
      expect(failed).toEqual(snapshot) // Retry never moves the failed launch
    }
  })

  it('[INV-54, S5.08a] a launch that is not failed, or whose cause has no Retry, cannot be retried', () => {
    const notRetryable = failedLaunch('jev-could-not-choose', request(true))
    const running: Launch = { ...failedLaunch('not-installed', request(false)), state: 'spawned' }
    delete (running as { failure?: unknown }).failure

    for (const launch of [notRetryable, running]) {
      expect(retryLaunch(launch, { id: 'launch-2' as LaunchId, hostEpoch: 'epoch-2' })).toEqual({
        ok: false,
        error: 'not-retryable'
      })
    }
  })
})
