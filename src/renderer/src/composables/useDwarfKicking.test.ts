// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DwarfKickResult } from '../types'
import { RESULT_VISIBLE_MS, useDwarfKicking } from './useDwarfKicking'

function stubApi(kickDwarf: (...args: never[]) => Promise<DwarfKickResult>): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { kickDwarf }
  })
}

/** Resolves only when `release()` is called, so a pending state can be observed. */
function deferred<T>() {
  let release!: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

describe('useDwarfKicking', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useDwarfKicking().clearAll()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('marks the dwarf as kicking until the verdict arrives', async () => {
    const pending = deferred<DwarfKickResult>()
    stubApi(() => pending.promise)
    const { kick, stateFor } = useDwarfKicking()

    const kicking = kick('claude:s1')
    expect(stateFor('claude:s1')).toEqual({ phase: 'kicking' })

    pending.release({ delivered: true, via: 'terminal' })
    await kicking
    expect(stateFor('claude:s1')).toEqual({ phase: 'delivered', via: 'terminal' })
  })

  it('keeps the failure reason so the panel can explain itself', async () => {
    stubApi(() =>
      Promise.resolve({
        delivered: false,
        via: 'terminal',
        error: 'The agent terminal could not be reached.'
      })
    )
    const { kick, stateFor } = useDwarfKicking()

    await kick('claude:s1')
    expect(stateFor('claude:s1')).toEqual({
      phase: 'failed',
      via: 'terminal',
      error: 'The agent terminal could not be reached.'
    })
  })

  it('turns a broken IPC call into a failed state rather than an unhandled rejection', async () => {
    stubApi(() => Promise.reject(new Error('bridge is gone')))
    const { kick, stateFor } = useDwarfKicking()

    await kick('claude:s1')
    expect(stateFor('claude:s1')?.phase).toBe('failed')
    expect(stateFor('claude:s1')?.error).toBeTruthy()
  })

  it('clears the verdict after it has been on screen long enough to read', async () => {
    stubApi(() => Promise.resolve({ delivered: true, via: 'terminal' }))
    const { kick, stateFor } = useDwarfKicking()

    await kick('claude:s1')
    expect(stateFor('claude:s1')?.phase).toBe('delivered')

    vi.advanceTimersByTime(RESULT_VISIBLE_MS)
    expect(stateFor('claude:s1')).toBeUndefined()
  })

  it('ignores a second kick while the first is still in flight', async () => {
    const pending = deferred<DwarfKickResult>()
    const api = vi.fn().mockReturnValue(pending.promise)
    stubApi(api as never)
    const { kick } = useDwarfKicking()

    const first = kick('claude:s1')
    await kick('claude:s1')
    expect(api).toHaveBeenCalledTimes(1)

    pending.release({ delivered: true, via: 'terminal' })
    await first
  })

  it('tracks each dwarf separately', async () => {
    stubApi(() => Promise.resolve({ delivered: true, via: 'terminal' }))
    const { kick, stateFor } = useDwarfKicking()

    await kick('claude:s1')
    expect(stateFor('claude:s1')?.phase).toBe('delivered')
    expect(stateFor('claude:s2')).toBeUndefined()
  })

  it('passes the dwarf id straight through to the main process', async () => {
    const api = vi.fn().mockResolvedValue({ delivered: true, via: 'terminal' })
    stubApi(api as never)
    const { kick } = useDwarfKicking()

    await kick('claude:s1')
    expect(api).toHaveBeenCalledWith({ dwarfId: 'claude:s1' })
  })
})
