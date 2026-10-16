// A single-consumer async stream that buffers until read and ends once closed and drained (15 §1.3
// `events()`: earlier provider output is buffered, never dropped). The same shape the
// SimulatedDriver and the Claude stream-json driver keep privately; a driver folder owns its copy
// until a shared one exists.
export class EventChannel<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = []
  private readonly waiting: ((result: IteratorResult<T>) => void)[] = []
  private closed = false

  push(value: T): void {
    if (this.closed) return
    const reader = this.waiting.shift()
    if (reader === undefined) this.buffer.push(value)
    else reader({ value, done: false })
  }

  close(): void {
    this.closed = true
    for (const reader of this.waiting.splice(0)) reader({ value: undefined, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift() as T, done: false })
        }
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => this.waiting.push(resolve))
      }
    }
  }
}
