import type { App } from 'electron'
import type { SingleInstanceLock } from '../ports/singleInstanceLock'

type SecondLaunch = Parameters<Parameters<SingleInstanceLock['onSecondLaunch']>[0]>[0]

/** What a version in the lock's additional data may look like: a build version, never free text or a path. */
const APP_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/

/**
 * `SingleInstanceLock` over Electron's own lock (16 §4.14 as amended by AMENDMENT-25; ADR-002 D3; PO #73):
 *
 * - `acquire(launch)` is `app.requestSingleInstanceLock(additionalData)`; the launch's version travels as the
 *   additional data, which Electron hands to the holder's `second-instance` event (Electron 44 `app` docs).
 * - A later launch reaches the holder as `second-instance`: its version is read from the additional data (anything
 *   that is not `{ appVersion: <a version> }` is a launch without a version), and its argv is kept only to start
 *   that same program again.
 * - `replaceWithIt()` releases the lock, asks Electron to start the launch's own executable with its own arguments
 *   when this process quits (`app.relaunch({ execPath: argv[0], args: argv.slice(1) })`), and quits this UI process.
 *   It runs after the event (`defer`): Electron answers the later launch only once the event returned, and a lock
 *   released before that answer is taken by the later launch itself, so the relaunched program would then be the one
 *   turned away (two-process reproduction on Electron 44, AMENDMENT-25 PR). Deferred, the later launch is refused and
 *   quits on its own (UC-033 step 4) and the relaunched program takes the lock. It happens once per process.
 */
export class ElectronSingleInstanceLock implements SingleInstanceLock {
  private replacing = false

  constructor(
    private readonly app: Pick<
      App,
      'requestSingleInstanceLock' | 'releaseSingleInstanceLock' | 'relaunch' | 'quit' | 'on'
    >,
    private readonly defer: (work: () => void) => void = (work) => void setImmediate(work)
  ) {}

  acquire(launch?: { appVersion: string }): boolean {
    return launch === undefined
      ? this.app.requestSingleInstanceLock()
      : this.app.requestSingleInstanceLock({ appVersion: launch.appVersion })
  }

  onSecondLaunch(h: (launch: SecondLaunch) => void): void {
    this.app.on('second-instance', (_event, argv, _workingDirectory, additionalData) => {
      const appVersion = versionOf(additionalData)
      h({
        ...(appVersion === undefined ? {} : { appVersion }),
        replaceWithIt: () => this.replaceWith(argv)
      })
    })
  }

  private replaceWith(argv: readonly string[]): void {
    if (this.replacing) return
    this.replacing = true
    const [execPath, ...args] = argv
    this.defer(() => {
      this.app.releaseSingleInstanceLock()
      if (execPath !== undefined) this.app.relaunch({ execPath, args })
      this.app.quit()
    })
  }
}

function versionOf(additionalData: unknown): string | undefined {
  if (typeof additionalData !== 'object' || additionalData === null) return undefined
  const appVersion = (additionalData as { appVersion?: unknown }).appVersion
  return typeof appVersion === 'string' && APP_VERSION.test(appVersion) ? appVersion : undefined
}
