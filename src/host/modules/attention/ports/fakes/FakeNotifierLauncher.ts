// The NotifierLauncher double (16 §4.11 `FakeNotifierLauncher`: the respawn budget with
// `FakeClock`). Never imported by production code (R14). It starts nothing: it records the clock's
// instant of every `ensureNotifier` call, so a test reads when and how often the app would have been
// started, and keeps each call pending until the test settles it, as the real start stays pending
// until the notifier attaches or the process exits.
import type { Instant } from '../../../../kernel/domain/values'
import type { Clock } from '../../../../kernel/ports/clock'
import type { NotifierLauncher } from '../notifierLauncher'

export type NotifierLaunchOutcome = 'attached' | 'spawn-failed' | 'gave-up'

export class FakeNotifierLauncher implements NotifierLauncher {
  /** The instant of every start, in call order. */
  readonly starts: Instant[] = []
  private readonly pending: Array<(outcome: NotifierLaunchOutcome) => void> = []

  constructor(private readonly clock: Clock) {}

  ensureNotifier(): Promise<NotifierLaunchOutcome> {
    this.starts.push(this.clock.now())
    return new Promise((resolve) => this.pending.push(resolve))
  }

  /** How many starts are still waiting for an outcome. */
  get unsettled(): number {
    return this.pending.length
  }

  /** Settles the oldest pending start with `outcome`; throws when none is pending. */
  settle(outcome: NotifierLaunchOutcome): void {
    const resolve = this.pending.shift()
    if (resolve === undefined) throw new Error('FakeNotifierLauncher.settle: no start is pending')
    resolve(outcome)
  }
}
