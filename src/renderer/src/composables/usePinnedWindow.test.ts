// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { usePinnedWindow } from './usePinnedWindow'

function stubApi(api: {
  getAlwaysOnTop?: () => Promise<boolean>
  setAlwaysOnTop?: (pinned: boolean) => Promise<boolean>
}): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: api
  })
}

/** Resolves only when `release()` is called, so an in-flight toggle can be observed. */
function deferred<T>() {
  let release!: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

describe('usePinnedWindow', () => {
  it('starts from the pinned default before the first sync, matching the main default', () => {
    stubApi({})
    const { pinned } = usePinnedWindow()
    expect(pinned.value).toBe(true)
  })

  it('adopts the real window state on sync', async () => {
    stubApi({ getAlwaysOnTop: () => Promise.resolve(false) })
    const { pinned, sync } = usePinnedWindow()
    await sync()
    expect(pinned.value).toBe(false)
  })

  it('keeps the last known state when sync cannot reach the main process', async () => {
    stubApi({ getAlwaysOnTop: () => Promise.reject(new Error('bridge is gone')) })
    const { pinned, sync } = usePinnedWindow()
    await sync()
    expect(pinned.value).toBe(true)
  })

  it('requests the opposite of the current state on toggle', async () => {
    const setAlwaysOnTop = vi.fn().mockResolvedValue(false)
    stubApi({ setAlwaysOnTop })
    const { toggle } = usePinnedWindow()
    await toggle()
    expect(setAlwaysOnTop).toHaveBeenCalledWith(false)
  })

  it('renders only the returned real state, even when it differs from the wish', async () => {
    // The main process read the state back from the BrowserWindow and reports
    // the unpin did not take (e.g. the window manager ignored the hint).
    stubApi({ setAlwaysOnTop: () => Promise.resolve(true) })
    const { pinned, toggle } = usePinnedWindow()
    await toggle()
    expect(pinned.value).toBe(true)
  })

  it('re-renders the actual state after a failed toggle, never the wished one', async () => {
    stubApi({
      setAlwaysOnTop: () => Promise.reject(new Error('handler crashed')),
      getAlwaysOnTop: () => Promise.resolve(false)
    })
    const { pinned, toggle } = usePinnedWindow()
    await toggle()
    // The wish was "unpin" (from the default true); the failure path must ask
    // the window what actually happened rather than assume either outcome.
    expect(pinned.value).toBe(false)
  })

  it('keeps the last known state when the failed toggle cannot even be re-synced', async () => {
    stubApi({
      setAlwaysOnTop: () => Promise.reject(new Error('bridge is gone')),
      getAlwaysOnTop: () => Promise.reject(new Error('bridge is gone'))
    })
    const { pinned, toggle } = usePinnedWindow()
    await toggle()
    expect(pinned.value).toBe(true)
  })

  it('ignores a second toggle while the first is still in flight', async () => {
    const pending = deferred<boolean>()
    const setAlwaysOnTop = vi.fn().mockReturnValue(pending.promise)
    stubApi({ setAlwaysOnTop })
    const { toggle } = usePinnedWindow()

    const first = toggle()
    await toggle()
    expect(setAlwaysOnTop).toHaveBeenCalledTimes(1)

    pending.release(false)
    await first
  })
})
