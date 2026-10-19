// layer: L2
import { describe, expect, it } from 'vitest'
import { FakePanelWindowController } from '../ports/fakes/FakePanelWindowController'
import { FakeSingleInstanceLock } from '../ports/fakes/FakeSingleInstanceLock'
import type { UiLogEntry } from '../../diagnostics/uiLogger'
import { uiRecordRefusal } from '../../diagnostics/uiRecordRules'
import { wireSecondLaunch } from './secondLaunch'

/**
 * The second launch of the app (07 S10.02, UC-033, FM-138): the running instance comes forward,
 * shown if it was hidden, and nothing else happens — no second window, no notice, no dialog.
 */
describe('second launch (S10.02)', () => {
  function runningInstance(state: ConstructorParameters<typeof FakePanelWindowController>[0]) {
    const lock = new FakeSingleInstanceLock(true)
    const panel = new FakePanelWindowController(state)
    wireSecondLaunch(lock).attach(panel)
    return { lock, panel }
  }

  it('[US-RES-008.AC01, S10.02] a second launch while the window is shown brings it to the front and starts nothing', () => {
    const { lock, panel } = runningInstance({ visible: true })

    lock.launchAgain()

    expect(panel.visible).toBe(true)
    expect(panel.frontmost).toBe(true)
    expect(panel.calls).toEqual(['show'])
    expect(lock.acquireCalls).toBe(0)
  })

  it('[US-RES-008.AC02, S10.02] a second launch while the window is hidden shows it as it was left', () => {
    const left = { edge: 'left', mineOpen: true, dockOpen: true } as const
    const { lock, panel } = runningInstance({ visible: false, layout: left })

    lock.launchAgain()

    expect(panel.visible).toBe(true)
    expect(panel.frontmost).toBe(true)
    expect(panel.currentLayout).toEqual(left)
    expect(panel.calls).toEqual(['show'])
  })

  it('[US-RES-008.AC03, FM-138] every further launch brings the same instance forward, ten times in a row', () => {
    const { lock, panel } = runningInstance({ visible: false })

    for (let launch = 1; launch <= 10; launch += 1) {
      panel.frontmost = false
      lock.launchAgain()
      expect(panel.visible).toBe(true)
      expect(panel.frontmost).toBe(true)
    }

    expect(panel.calls).toEqual(Array.from({ length: 10 }, () => 'show'))
    expect(lock.listenerCount).toBe(1)
  })

  it('[US-RES-008.AC04] a second launch shows no notice and no dialog', () => {
    // The use case is given only the lock and the Panel window: it has no notice, toast or dialog
    // collaborator to reach, and its one visible effect is the window coming forward.
    const { lock, panel } = runningInstance({ visible: false })

    lock.launchAgain()

    expect(panel.calls).toEqual(['show'])
  })

  it('[US-RES-008.AC01, S10.02] a second launch while the running instance is still starting brings the window forward once it exists', () => {
    const lock = new FakeSingleInstanceLock(true)
    const secondLaunch = wireSecondLaunch(lock)
    const panel = new FakePanelWindowController({ visible: false })

    lock.launchAgain()
    lock.launchAgain()
    expect(panel.calls).toEqual([])

    secondLaunch.attach(panel)

    expect(panel.calls).toEqual(['show'])
    expect(panel.visible).toBe(true)
  })
})

/**
 * A newer build launched while an older one runs (AMENDMENT-25, 16 §4.14 as amended; ADR-002 D3, D7): the running
 * instance replaces itself with that launch — the lock released, the launch's own program started, this UI process
 * quit — and never touches the Host. An equal or older launch, or one without a version, keeps today's behaviour.
 */
describe('a newer launch replaces the running instance (AMENDMENT-25)', () => {
  const RUNNING = '0.13.1'

  function recordingLog() {
    const records: UiLogEntry[] = []
    const order: string[] = []
    return {
      records,
      order,
      log: {
        record: (entry: UiLogEntry) => {
          records.push(entry)
          order.push('record')
        },
        flush: async () => {
          order.push('flush')
        }
      }
    }
  }

  function runningInstance(log = recordingLog()) {
    const lock = new FakeSingleInstanceLock(true)
    const panel = new FakePanelWindowController({ visible: false })
    const secondLaunch = wireSecondLaunch(lock, { appVersion: RUNNING, log: log.log })
    return { lock, panel, secondLaunch, log }
  }

  /** Lets the use case finish what it does after the event (the log is written out first). */
  const settled = () => new Promise<void>((resolve) => setImmediate(resolve))

  it('[ADR-002, US-RES-008.AC03] a launch of a newer version makes the running instance replace itself with it and shows nothing', async () => {
    const { lock, panel, secondLaunch } = runningInstance()
    secondLaunch.attach(panel)

    lock.launchAgain({ appVersion: '0.13.2', program: ['DwarfAI-Miners.exe'] })
    await settled()

    expect(lock.effects).toEqual(['release', 'relaunch DwarfAI-Miners.exe', 'quit'])
    expect(panel.calls).toEqual([])
  })

  it('[ADR-002, US-RES-008.AC01, US-RES-008.AC03] an equal or older launch, or one without a version, only brings the window forward', async () => {
    const { lock, panel, secondLaunch } = runningInstance()
    secondLaunch.attach(panel)

    lock.launchAgain({ appVersion: RUNNING })
    lock.launchAgain({ appVersion: '0.13.0' })
    lock.launchAgain({})
    lock.launchAgain({ appVersion: 'dev' })
    await settled()

    expect(lock.effects).toEqual([])
    expect(lock.replacedItself).toBe(false)
    expect(panel.calls).toEqual(['show', 'show', 'show', 'show'])
  })

  it('[ADR-002, US-RES-008.AC03] a newer launch while the running instance is still starting replaces it at once, and the window never shows', async () => {
    const { lock, panel, secondLaunch } = runningInstance()

    lock.launchAgain({ appVersion: '0.14.0' })
    await settled()
    secondLaunch.attach(panel)

    expect(lock.replacedItself).toBe(true)
    expect(panel.calls).toEqual([])
  })

  it('[ADR-002, US-RES-008.AC03] once the instance is replacing itself, a further launch neither shows the window nor replaces it again', async () => {
    const { lock, panel, secondLaunch } = runningInstance()
    secondLaunch.attach(panel)

    lock.launchAgain({ appVersion: '0.13.2' })
    lock.launchAgain({ appVersion: RUNNING })
    lock.launchAgain({ appVersion: '0.13.3' })
    await settled()

    expect(lock.effects).toEqual(['release', 'relaunch DwarfAI-Miners', 'quit'])
    expect(panel.calls).toEqual([])
  })

  it('[ADR-002, ADR-026] stepping aside is logged with allowlisted fields only, and written out before the process quits', async () => {
    const log = recordingLog()
    const { lock } = runningInstance(log)

    lock.launchAgain({ appVersion: '0.13.2' })
    expect(lock.replacedItself).toBe(false)
    await settled()

    expect(log.records).toEqual([
      {
        level: 'info',
        event: 'ui.single-instance',
        subsystem: 'window',
        outcome: 'ok',
        causeClass: 'replaced-by-newer-launch',
        msg: 'stepped aside for a newer launch'
      }
    ])
    expect(log.records.map((entry) => uiRecordRefusal(entry))).toEqual([null])
    expect(log.order).toEqual(['record', 'flush'])
    expect(lock.replacedItself).toBe(true)
  })
})
