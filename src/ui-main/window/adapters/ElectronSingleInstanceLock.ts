import type { App } from 'electron'
import type { SingleInstanceLock } from '../ports/singleInstanceLock'

/**
 * `SingleInstanceLock` over Electron's own lock (16 §4.14; ADR-002 D3; PO #73): `acquire()` is
 * `app.requestSingleInstanceLock()`, and a later launch of the app reaches the holder as the
 * `second-instance` event. The event's arguments (argv, working directory) are not passed on: a
 * second launch only brings the running instance forward (S10.02, UC-033).
 */
export class ElectronSingleInstanceLock implements SingleInstanceLock {
  constructor(private readonly app: Pick<App, 'requestSingleInstanceLock' | 'on'>) {}

  acquire(): boolean {
    return this.app.requestSingleInstanceLock()
  }

  onSecondLaunch(h: () => void): void {
    this.app.on('second-instance', () => h())
  }
}
