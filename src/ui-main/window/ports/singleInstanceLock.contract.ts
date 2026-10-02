import { describe, expect, it } from 'vitest'
import type { SingleInstanceLock } from './singleInstanceLock'

export interface SingleInstanceLockSubject {
  lock: SingleInstanceLock
  /** The person starts the app once more while this instance holds the lock. */
  launchAgain(): void
}

/**
 * The `SingleInstanceLock` contract (16 §4.14, 16 §2.8; ADR-002 D3), run by the double and by the real adapter
 * alike: `acquire()` answers `true` when no other instance holds the lock and `false` when one does; each later
 * launch reaches the holder's `onSecondLaunch` handler once (US-RES-008.AC03, FM-138). `make` answers a subject
 * started while another instance holds the lock, or not.
 */
export function runSingleInstanceLockContract(
  name: string,
  make: (another: { holdsLock: boolean }) => SingleInstanceLockSubject
): void {
  describe(`${name} meets the SingleInstanceLock contract (16 §4.14)`, () => {
    it('[US-RES-008.AC03] the first instance acquires the lock; one started while another holds it does not', () => {
      expect(make({ holdsLock: false }).lock.acquire()).toBe(true)
      expect(make({ holdsLock: true }).lock.acquire()).toBe(false)
    })

    it('[US-RES-008.AC03, FM-138] each later launch reaches the holder once', () => {
      const subject = make({ holdsLock: false })
      subject.lock.acquire()
      let launches = 0
      subject.lock.onSecondLaunch(() => (launches += 1))

      subject.launchAgain()
      subject.launchAgain()

      expect(launches).toBe(2)
    })
  })
}
