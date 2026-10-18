// layer: L3
// The SessionStarter bridge passes the launching module's `runSessionStarterContract` (16 §4.5,
// §2.8; 17 §1.3), over a scripted driver behind the suppliers `DriverRegistry` and the
// `SessionChannels` read of its early window. The bridge-only cases below pin its timed checks
// against a scheduler that runs ahead of the clock.
import { describe, expect, it } from 'vitest'
import type { FolderPath, LaunchId, ProviderId } from '../../kernel/domain/values'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import type { Scheduler } from '../../kernel/ports/scheduler'
import {
  EARLY_FAILURE_WINDOW_MS,
  HANDSHAKE_TIMEOUT_MS,
  type StartResult
} from '../../modules/launching'
import { ScriptedDriver } from '../../modules/launching/testing/ScriptedDriver'
import {
  CONTRACT_LAUNCH,
  runSessionStarterContract
} from '../../modules/launching/testing/sessionStarter.contract'
import type { DriverLaunchRequest, ProviderDriver } from '../../modules/suppliers'
import { createSessionStarter } from './sessionStarter'

runSessionStarterContract('the SessionStarter bridge', () => {
  const clock = new FakeClock(1_790_000_000_000)
  const scheduler = new FakeScheduler(clock)
  const providerId = 'contract' as ProviderId
  const scripted = new ScriptedDriver({ providerId, label: 'Contract tool', clock, scheduler })
  return {
    starter: createSessionStarter({
      launchDriver: async (id) => scripted.registry.drivers(id)[0],
      sessions: scripted.sessions,
      clock,
      scheduler
    }),
    clock,
    providerId,
    arrange: (script) => scripted.arrange(script)
  }
})

/**
 * A scheduler whose timers run 1 ms before their due instant, the way a monotonic `setTimeout`
 * can fire before the wall clock `Date.now()` reads has reached the deadline. A 1 ms timer runs
 * on time, so a re-armed check makes progress.
 */
function runningAhead(inner: Scheduler): Scheduler {
  return { after: (ms, task) => inner.after(ms > 1 ? ms - 1 : ms, task) }
}

/** Lets the promise jobs queued so far run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve()
}

/** Moves the clock in 10 ms steps, letting promise jobs run between steps. */
async function advance(clock: FakeClock, ms: number): Promise<void> {
  let left = ms
  while (left > 0) {
    const step = Math.min(10, left)
    clock.advance(step)
    left -= step
    await flush()
  }
}

function request(launchId: LaunchId): DriverLaunchRequest {
  return {
    launchId,
    install: {
      providerId: 'contract' as ProviderId,
      binaryPath: '/opt/contract/bin/tool',
      version: '1.0.0',
      resolvedVia: 'path',
      statMtimeMs: 0
    },
    cwd: '/work/mine-one' as FolderPath,
    prompt: 'Survey the north seam',
    permissionMode: null,
    delegation: null,
    spawnTag: `v1:install-162:${launchId}:epoch-162`,
    onSpawned: async () => undefined
  }
}

describe('the SessionStarter bridge, with timers that run ahead of the clock', () => {
  const providerId = 'contract' as ProviderId

  function arrangeBridge(driverOf?: (scripted: ScriptedDriver) => ProviderDriver): {
    clock: FakeClock
    start: () => () => StartResult | undefined
  } {
    const clock = new FakeClock(1_790_000_000_000)
    const scheduler = new FakeScheduler(clock)
    const scripted = new ScriptedDriver({ providerId, label: 'Contract tool', clock, scheduler })
    const driver = driverOf?.(scripted)
    const starter = createSessionStarter({
      launchDriver: async (id) => driver ?? scripted.registry.drivers(id)[0],
      sessions: scripted.sessions,
      clock,
      scheduler: runningAhead(scheduler)
    })
    return {
      clock,
      start: () => {
        let result: StartResult | undefined
        void starter
          .start(providerId, request(CONTRACT_LAUNCH), { launchedWithLetJevChoose: false })
          .then((value) => {
            result = value
          })
        return () => result
      }
    }
  }

  it('[S5.21, S5.18] a window-end check that runs before the clock reaches t0 + 3 s checks again, and the start resolves ok once the window has passed', async () => {
    const { clock, start } = arrangeBridge()
    const result = start()
    await flush()
    await advance(clock, EARLY_FAILURE_WINDOW_MS - 1)
    expect(result()).toBeUndefined()
    await advance(clock, 1)
    expect(result()?.ok).toBe(true)
  })

  it('[S5.19] a handshake check that runs before the clock reaches t0 + the budget checks again, and the start settles could-not-start once the budget has passed', async () => {
    const { clock, start } = arrangeBridge((scripted) => ({
      ...scripted.driver,
      launch: async (req) => {
        await req.onSpawned({ pid: 50_001, processStartTimeMs: clock.now(), bootId: 'hanging' })
        return new Promise(() => undefined) // the handshake never answers
      }
    }))
    const result = start()
    await flush()
    clock.advance(HANDSHAKE_TIMEOUT_MS - 1)
    await flush()
    expect(result()).toBeUndefined()
    clock.advance(1)
    await flush()
    expect(result()).toMatchObject({ ok: false, error: { cause: 'could-not-start' } })
  })
})
