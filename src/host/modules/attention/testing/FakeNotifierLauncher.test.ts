import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { FakeNotifierLauncher } from '../ports/fakes/FakeNotifierLauncher'
import { runNotifierLauncherContract } from './notifierLauncher.contract'

// L3 (17 §1.3): the double runs the same contract as `AppBackgroundNotifierLauncher`. A notifier
// attaching settles the pending start; a failed start settles it `spawn-failed`.
describe('FakeNotifierLauncher', () => {
  runNotifierLauncherContract(() => {
    const launcher = new FakeNotifierLauncher(new FakeClock(0))
    return {
      launcher,
      notifierAttaches: () => {
        if (launcher.unsettled > 0) launcher.settle('attached')
      },
      startFails: () => launcher.settle('spawn-failed'),
      dispose: () => undefined
    }
  })

  it('[ADR-018] records the clock instant of every start', () => {
    const clock = new FakeClock(1_000)
    const launcher = new FakeNotifierLauncher(clock)
    void launcher.ensureNotifier()
    clock.advance(2_000)
    void launcher.ensureNotifier()
    expect(launcher.starts).toStrictEqual([1_000, 3_000])
    expect(launcher.unsettled).toBe(2)
  })
})
