// layer: L3
import { runSingleInstanceLockContract } from '../ports/singleInstanceLock.contract'
import { ElectronSingleInstanceLock } from './ElectronSingleInstanceLock'

/**
 * Electron's own lock as its documentation and the OS lane (src/ui-main/singleInstance.os.test.ts) show it:
 * `requestSingleInstanceLock()` answers `false` while another instance of the app holds the lock, and each later
 * launch emits `second-instance` (with its argv and working folder) on the holder. The real Electron leg of the
 * contract's cases is that OS-lane test (17 §1.3).
 */
class ModelledApp {
  private readonly listeners: Array<(...args: unknown[]) => void> = []

  constructor(private readonly anotherHolds: boolean) {}

  requestSingleInstanceLock(): boolean {
    return !this.anotherHolds
  }

  on(event: string, listener: (...args: unknown[]) => void): this {
    if (event === 'second-instance') this.listeners.push(listener)
    return this
  }

  launchAgain(): void {
    for (const listener of this.listeners) listener({}, ['DwarfAI-Miners.exe'], 'C:/work')
  }
}

runSingleInstanceLockContract('ElectronSingleInstanceLock over Electron app', ({ holdsLock }) => {
  const app = new ModelledApp(holdsLock)
  return {
    lock: new ElectronSingleInstanceLock(app as never),
    launchAgain: () => app.launchAgain()
  }
})
