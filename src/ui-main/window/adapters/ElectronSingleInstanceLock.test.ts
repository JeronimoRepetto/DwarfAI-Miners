// layer: L3
import { describe, expect, it } from 'vitest'
import { runSingleInstanceLockContract } from '../ports/singleInstanceLock.contract'
import { ElectronSingleInstanceLock } from './ElectronSingleInstanceLock'

/**
 * Electron's own lock as its documentation and the OS lane (src/ui-main/singleInstance.os.test.ts) show it:
 * `requestSingleInstanceLock(additionalData)` answers `false` while another instance of the app holds the lock, and
 * each later launch emits `second-instance` (with its argv, working folder and additional data) on the holder;
 * `releaseSingleInstanceLock()` frees the lock, `relaunch({ execPath, args })` starts a program when this process
 * quits, and `quit()` quits it. The real Electron leg of the contract's cases is that OS-lane test (17 §1.3).
 */
class ModelledApp {
  readonly calls: string[] = []
  readonly additionalData: unknown[] = []
  readonly deferred: Array<() => void> = []
  private readonly listeners: Array<(...args: unknown[]) => void> = []

  constructor(private readonly anotherHolds: boolean) {}

  requestSingleInstanceLock(additionalData?: Record<string, unknown>): boolean {
    this.additionalData.push(additionalData)
    return !this.anotherHolds
  }

  releaseSingleInstanceLock(): void {
    this.calls.push('release')
  }

  relaunch(options?: { execPath?: string; args?: string[] }): void {
    this.calls.push(['relaunch', options?.execPath ?? '', ...(options?.args ?? [])].join(' '))
  }

  quit(): void {
    this.calls.push('quit')
  }

  on(event: string, listener: (...args: unknown[]) => void): this {
    if (event === 'second-instance') this.listeners.push(listener)
    return this
  }

  launchAgain(additionalData: unknown, argv: readonly string[] = ['DwarfAI-Miners.exe']): void {
    for (const listener of this.listeners) listener({}, [...argv], 'C:/work', additionalData)
  }

  /** Runs the work the adapter deferred past the event. */
  settle(): void {
    for (const work of this.deferred.splice(0)) work()
  }
}

function adapterOver(app: ModelledApp): ElectronSingleInstanceLock {
  return new ElectronSingleInstanceLock(app as never, (work) => app.deferred.push(work))
}

runSingleInstanceLockContract('ElectronSingleInstanceLock over Electron app', ({ holdsLock }) => {
  const app = new ModelledApp(holdsLock)
  return {
    lock: adapterOver(app),
    launchAgain: (launch = {}) =>
      app.launchAgain(
        launch.appVersion === undefined ? undefined : { appVersion: launch.appVersion },
        launch.program
      ),
    effects: () => {
      app.settle()
      return app.calls
    }
  }
})

describe('ElectronSingleInstanceLock (AMENDMENT-25)', () => {
  it('[ADR-002, US-RES-008.AC03] acquire hands the launch’s version to Electron as the lock’s additional data, and passes none without one', () => {
    const app = new ModelledApp(true)
    const lock = adapterOver(app)

    lock.acquire({ appVersion: '0.13.2' })
    lock.acquire()

    expect(app.additionalData).toEqual([{ appVersion: '0.13.2' }, undefined])
  })

  it('[ADR-002, US-RES-008.AC03] additional data that is not a version object reaches the holder as a launch without a version', () => {
    const app = new ModelledApp(false)
    const lock = adapterOver(app)
    const versions: Array<string | undefined> = []
    lock.onSecondLaunch((launch) => versions.push(launch.appVersion))

    for (const data of [null, 'x', 42, [], { appVersion: 7 }, { appVersion: 'a b/c' }, {}]) {
      app.launchAgain(data)
    }

    expect(versions).toEqual(Array.from({ length: 7 }, () => undefined))
  })

  it('[ADR-002, US-RES-008.AC03] the replacement runs after the event, so the later launch is answered first and quits on its own (UC-033 step 4)', () => {
    const app = new ModelledApp(false)
    const lock = adapterOver(app)
    lock.onSecondLaunch((launch) => launch.replaceWithIt())

    app.launchAgain({ appVersion: '0.13.2' }, ['/opt/DwarfAI/dwarfai-miners', '--background'])

    expect(app.calls).toEqual([])
    app.settle()
    expect(app.calls).toEqual([
      'release',
      'relaunch /opt/DwarfAI/dwarfai-miners --background',
      'quit'
    ])
  })
})
