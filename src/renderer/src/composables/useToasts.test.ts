// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useToasts } from './useToasts'

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.runAllTimers()
  vi.useRealTimers()
})

describe('useToasts', () => {
  it('shares one queue: a toast raised anywhere is the one the host lists', () => {
    const raiser = useToasts()
    const host = useToasts()
    raiser.showToast('Music off', 'music-off')
    expect(host.toasts.value.map((t) => [t.text, t.icon])).toEqual([['Music off', 'music-off']])
  })

  it('lets each toast go after 2.6s', () => {
    const { showToast, toasts } = useToasts()
    showToast('alpha removed')
    vi.advanceTimersByTime(2599)
    expect(toasts.value.map((t) => t.text)).toContain('alpha removed')
    vi.advanceTimersByTime(1)
    expect(toasts.value.map((t) => t.text)).not.toContain('alpha removed')
  })
})
