import type { SingleInstanceLock } from '../singleInstanceLock'

type SecondLaunch = Parameters<Parameters<SingleInstanceLock['onSecondLaunch']>[0]>[0]

/**
 * Hand-written double of `SingleInstanceLock` (16 §4.14 as amended by AMENDMENT-25, 16 §2.8). `acquired` is what
 * `acquire()` answers; `launchAgain()` plays the OS delivering one `second-instance` event to this process, and
 * `effects` records what `replaceWithIt()` did to the lock and the process (`release`, `relaunch <program…>`, `quit`).
 */
export class FakeSingleInstanceLock implements SingleInstanceLock {
  acquireCalls = 0
  /** The launch each `acquire` call carried, in order. */
  readonly acquiredWith: Array<{ appVersion: string } | undefined> = []
  readonly effects: string[] = []
  private readonly handlers: Array<(launch: SecondLaunch) => void> = []
  private replaced = false

  constructor(private readonly acquired: boolean) {}

  acquire(launch?: { appVersion: string }): boolean {
    this.acquireCalls += 1
    this.acquiredWith.push(launch)
    return this.acquired
  }

  onSecondLaunch(h: (launch: SecondLaunch) => void): void {
    this.handlers.push(h)
  }

  /** How many second-launch handlers are registered. */
  get listenerCount(): number {
    return this.handlers.length
  }

  /** Whether the instance replaced itself with a later launch. */
  get replacedItself(): boolean {
    return this.replaced
  }

  /** A later launch: the version it carried, if any, and its own program (executable and arguments). */
  launchAgain(launch: { appVersion?: string; program?: readonly string[] } = {}): void {
    const program = launch.program ?? ['DwarfAI-Miners']
    const delivered: SecondLaunch = {
      ...(launch.appVersion === undefined ? {} : { appVersion: launch.appVersion }),
      replaceWithIt: () => {
        if (this.replaced) return
        this.replaced = true
        this.effects.push('release', `relaunch ${program.join(' ')}`, 'quit')
      }
    }
    for (const handler of this.handlers) handler(delivered)
  }
}
