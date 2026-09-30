import { describe, expect, it } from 'vitest'
import { TOAST_MS, createToastQueue } from './toast'

// A hand-driven timer: each scheduled call waits in `pending` until the test runs it.
function manualTimers() {
  const pending: { run: () => void; ms: number }[] = []
  return {
    pending,
    schedule: (run: () => void, ms: number) => {
      pending.push({ run, ms })
    }
  }
}

describe('createToastQueue', () => {
  it('shows a line with the info icon by default', () => {
    const timers = manualTimers()
    const queue = createToastQueue(timers.schedule)
    queue.show('Sorted by name')
    expect(queue.toasts()).toEqual([{ id: 1, text: 'Sorted by name', icon: 'info' }])
  })

  it('shows the icon it is given', () => {
    const queue = createToastQueue(manualTimers().schedule)
    queue.show('Music off', 'music-off')
    expect(queue.toasts()[0]!.icon).toBe('music-off')
  })

  it('leaves after 2.6s, each toast on its own clock', () => {
    const timers = manualTimers()
    const queue = createToastQueue(timers.schedule)
    queue.show('first')
    queue.show('second')
    expect(timers.pending.map((t) => t.ms)).toEqual([TOAST_MS, TOAST_MS])
    expect(TOAST_MS).toBe(2600)
    timers.pending[0]!.run()
    expect(queue.toasts().map((t) => t.text)).toEqual(['second'])
  })

  it('tells its listener about every change', () => {
    const timers = manualTimers()
    const seen: number[] = []
    const queue = createToastQueue(timers.schedule, (list) => seen.push(list.length))
    queue.show('a')
    timers.pending[0]!.run()
    expect(seen).toEqual([1, 0])
  })
})
