import { describe, expect, it } from 'vitest'
import type { SingleInstanceLock } from './singleInstanceLock'

/** A later launch of the app, as the holder receives it: its version, if it carried one, and its own program. */
export interface LaterLaunch {
  appVersion?: string
  /** The launch's executable and arguments (Electron's `second-instance` argv). */
  program?: readonly string[]
}

export interface SingleInstanceLockSubject {
  lock: SingleInstanceLock
  /** The person starts the app once more while this instance holds the lock. */
  launchAgain(launch?: LaterLaunch): void
  /**
   * What this instance did to the lock and to its own process since it was made, in order, once any work the
   * adapter defers has run: `release`, `relaunch <program…>`, `quit`.
   */
  effects(): readonly string[]
}

const PROGRAM = ['C:/Apps/DwarfAI/DwarfAI-Miners.exe', '--background'] as const

/**
 * The `SingleInstanceLock` contract (16 §4.14 as amended by AMENDMENT-25, 16 §2.8; ADR-002 D3), run by the double
 * and by the real adapter alike: `acquire()` answers `true` when no other instance holds the lock and `false` when
 * one does; each later launch reaches the holder's `onSecondLaunch` handler once, with the version it carried; and
 * `replaceWithIt()` hands the app to that launch — the lock released, the launch's own program started, this UI
 * process quit — and does nothing else (US-RES-008.AC03, FM-138). `make` answers a subject started while another
 * instance holds the lock, or not.
 */
export function runSingleInstanceLockContract(
  name: string,
  make: (another: { holdsLock: boolean }) => SingleInstanceLockSubject
): void {
  describe(`${name} meets the SingleInstanceLock contract (16 §4.14)`, () => {
    it('[US-RES-008.AC03] the first instance acquires the lock; one started while another holds it does not', () => {
      expect(make({ holdsLock: false }).lock.acquire()).toBe(true)
      expect(make({ holdsLock: true }).lock.acquire()).toBe(false)
      expect(make({ holdsLock: false }).lock.acquire({ appVersion: '0.13.2' })).toBe(true)
      expect(make({ holdsLock: true }).lock.acquire({ appVersion: '0.13.2' })).toBe(false)
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

    it('[ADR-002, US-RES-008.AC03] a later launch reaches the holder with the version it carried, or with none', () => {
      const subject = make({ holdsLock: false })
      subject.lock.acquire({ appVersion: '0.13.1' })
      const versions: Array<string | undefined> = []
      subject.lock.onSecondLaunch((launch) => versions.push(launch.appVersion))

      subject.launchAgain({ appVersion: '0.13.2' })
      subject.launchAgain({})

      expect(versions).toEqual(['0.13.2', undefined])
    })

    it('[ADR-002, US-RES-008.AC03] replaceWithIt releases the lock, starts the launch’s own program and quits this UI process, and nothing else', () => {
      const subject = make({ holdsLock: false })
      subject.lock.acquire({ appVersion: '0.13.1' })
      subject.lock.onSecondLaunch((launch) => launch.replaceWithIt())

      subject.launchAgain({ appVersion: '0.13.2', program: PROGRAM })

      expect(subject.effects()).toEqual(['release', `relaunch ${PROGRAM.join(' ')}`, 'quit'])
    })

    it('[ADR-002, US-RES-008.AC03] a launch the holder does not replace itself with changes nothing, and a replacement happens once', () => {
      const subject = make({ holdsLock: false })
      subject.lock.acquire({ appVersion: '0.13.1' })
      const handed: Array<() => void> = []
      subject.lock.onSecondLaunch((launch) => handed.push(() => launch.replaceWithIt()))

      subject.launchAgain({ appVersion: '0.13.1', program: PROGRAM })
      expect(subject.effects()).toEqual([])

      subject.launchAgain({ appVersion: '0.13.2', program: PROGRAM })
      handed[1]?.()
      handed[1]?.()
      handed[0]?.()

      expect(subject.effects()).toEqual(['release', `relaunch ${PROGRAM.join(' ')}`, 'quit'])
    })
  })
}
