// layer: L2
import { describe, expect, it } from 'vitest'
import { FakePanelWindowController } from '../ports/fakes/FakePanelWindowController'
import { FakeSingleInstanceLock } from '../ports/fakes/FakeSingleInstanceLock'
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
