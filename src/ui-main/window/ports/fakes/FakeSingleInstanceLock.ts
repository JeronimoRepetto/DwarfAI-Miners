import type { SingleInstanceLock } from '../singleInstanceLock'

/**
 * Hand-written double of `SingleInstanceLock` (16 §4.14, 16 §2.8). `acquired` is what `acquire()`
 * answers; `launchAgain()` plays the OS delivering one `second-instance` event to this process.
 */
export class FakeSingleInstanceLock implements SingleInstanceLock {
  acquireCalls = 0
  private readonly handlers: Array<() => void> = []

  constructor(private readonly acquired: boolean) {}

  acquire(): boolean {
    this.acquireCalls += 1
    return this.acquired
  }

  onSecondLaunch(h: () => void): void {
    this.handlers.push(h)
  }

  /** How many second-launch handlers are registered. */
  get listenerCount(): number {
    return this.handlers.length
  }

  launchAgain(): void {
    for (const handler of this.handlers) handler()
  }
}
