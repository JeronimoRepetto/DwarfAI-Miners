// layer: L2
import { describe, expect, it } from 'vitest'
import { startUiMain, type UiMainDeps, type UiMainLifecycle } from './index'
import { FakePanelWindowController } from './window/ports/fakes/FakePanelWindowController'
import { FakeSingleInstanceLock } from './window/ports/fakes/FakeSingleInstanceLock'

/**
 * The Electron composition root (05 §2.3, 16 §8.4): the single-instance lock is the first thing it
 * takes; only a process that holds it composes today's runtime and its Panel window (ADR-001, ADR-002
 * D3, PO #73).
 */
describe('ui-main composition root (05 §2.3)', () => {
  /** Records every lifecycle call and lets the test decide when the app is ready. */
  class RecordingLifecycle implements UiMainLifecycle {
    readonly calls: string[] = []
    readonly handlers = new Map<string, () => void>()
    private ready: () => void = () => {}
    private readonly readyPromise = new Promise<void>((resolve) => {
      this.ready = resolve
    })

    quit(): void {
      this.calls.push('quit')
    }
    exit(code: number): void {
      this.calls.push(`exit ${code}`)
    }
    whenReady(): Promise<void> {
      this.calls.push('whenReady')
      return this.readyPromise
    }
    onBeforeQuit(h: () => void): void {
      this.calls.push('onBeforeQuit')
      this.handlers.set('before-quit', h)
    }
    onWillQuit(h: () => void): void {
      this.calls.push('onWillQuit')
      this.handlers.set('will-quit', h)
    }
    onWindowAllClosed(h: () => void): void {
      this.calls.push('onWindowAllClosed')
      this.handlers.set('window-all-closed', h)
    }
    becomeReady(): void {
      this.ready()
    }
  }

  /** A stand-in for LegacyRuntimeRoute that counts compositions and quit teardowns. */
  function countingLegacyRuntime(outcome: 'composes' | 'fails' = 'composes') {
    const panel = new FakePanelWindowController({ visible: false })
    const counts = { composed: 0, beforeQuit: 0, willQuit: 0 }
    const legacyRuntime: UiMainDeps['legacyRuntime'] = {
      async compose() {
        counts.composed += 1
        if (outcome === 'fails') throw new Error('today’s runtime could not start')
        return panel
      },
      beforeQuit() {
        counts.beforeQuit += 1
      },
      willQuit() {
        counts.willQuit += 1
      }
    }
    return { legacyRuntime, counts, panel }
  }

  it('[ADR-001] when the single-instance lock is not acquired the root quits before composing the legacy runtime or any window', async () => {
    const lock = new FakeSingleInstanceLock(false)
    const lifecycle = new RecordingLifecycle()
    const { legacyRuntime, counts, panel } = countingLegacyRuntime()

    await startUiMain({ lock, lifecycle, legacyRuntime })
    lifecycle.becomeReady()
    await Promise.resolve()

    expect(lock.acquireCalls).toBe(1)
    expect(lifecycle.calls).toEqual(['quit'])
    expect(counts.composed).toBe(0)
    expect(panel.calls).toEqual([])
    expect(lock.listenerCount).toBe(0)
  })

  it('[US-RES-008.AC01, S10.01] when the lock is acquired the root composes the legacy runtime once the app is ready and a second launch brings its Panel window forward', async () => {
    const lock = new FakeSingleInstanceLock(true)
    const lifecycle = new RecordingLifecycle()
    const { legacyRuntime, counts, panel } = countingLegacyRuntime()

    const started = startUiMain({ lock, lifecycle, legacyRuntime })
    lock.launchAgain() // the lock is taken but the window does not exist yet (UC-033)
    expect(counts.composed).toBe(0)

    lifecycle.becomeReady()
    await started

    expect(counts.composed).toBe(1)
    expect(panel.calls).toEqual(['show'])
    lock.launchAgain()
    expect(panel.calls).toEqual(['show', 'show'])
    expect(lifecycle.calls).not.toContain('quit')
  })

  it('[ADR-001] the root hands the app quit to today’s teardown and keeps running with every window closed', async () => {
    const lock = new FakeSingleInstanceLock(true)
    const lifecycle = new RecordingLifecycle()
    const { legacyRuntime, counts } = countingLegacyRuntime()

    const started = startUiMain({ lock, lifecycle, legacyRuntime })
    lifecycle.becomeReady()
    await started
    lifecycle.handlers.get('window-all-closed')?.()
    lifecycle.handlers.get('before-quit')?.()
    lifecycle.handlers.get('will-quit')?.()

    expect(counts).toEqual({ composed: 1, beforeQuit: 1, willQuit: 1 })
    expect(lifecycle.calls).not.toContain('quit')
    expect(lifecycle.calls.filter((call) => call.startsWith('exit'))).toEqual([])
  })

  it('[ADR-001] a start whose legacy runtime cannot be composed exits with code 1', async () => {
    const lock = new FakeSingleInstanceLock(true)
    const lifecycle = new RecordingLifecycle()
    const { legacyRuntime } = countingLegacyRuntime('fails')

    const started = startUiMain({ lock, lifecycle, legacyRuntime })
    lifecycle.becomeReady()
    await started

    expect(lifecycle.calls).toContain('exit 1')
  })
})
