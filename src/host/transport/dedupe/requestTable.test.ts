// layer: L1
// The in-memory requestId table (ADR-003 item 6, frozen; 14 §1.6): one effect per requestId, a
// repeat in flight joins the first call, a repeat within 10 min of settlement gets the first
// outcome verbatim, and the entry is forgotten after. Time is the injected FakeClock only.
import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { DEDUPE_TTL_MS, RequestTable } from './requestTable'

const R = '01890a5d-ac96-774b-bcce-b302099a8057'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

describe('RequestTable (ADR-003 item 6)', () => {
  it('[ADR-003] a settled result is returned verbatim for 10 minutes and forgotten after', async () => {
    const clock = new FakeClock()
    const table = new RequestTable<{ messageId: string }>({
      clock,
      scheduler: new FakeScheduler(clock)
    })
    let effects = 0
    const effect = (): Promise<{ messageId: string }> => {
      effects += 1
      return Promise.resolve({ messageId: `m${effects}` })
    }

    const first = table.run(R, effect)
    expect(first.repeat).toBe(false)
    const result = await first.outcome

    clock.advance(DEDUPE_TTL_MS - 1) // 599 999 ms after settlement
    const repeat = table.run(R, effect)
    expect(repeat.repeat).toBe(true)
    expect(await repeat.outcome).toBe(result)
    expect(effects).toBe(1)

    clock.advance(2) // 600 001 ms after settlement
    const later = table.run(R, effect)
    expect(later.repeat).toBe(false)
    expect(await later.outcome).toEqual({ messageId: 'm2' })
    expect(effects).toBe(2)
  })

  it('[ADR-003] the expiry holds on the clock alone, without a Scheduler sweep', async () => {
    const clock = new FakeClock()
    const table = new RequestTable<string>({ clock })
    let effects = 0
    const effect = (): Promise<string> => Promise.resolve(`r${(effects += 1)}`)

    await table.run(R, effect).outcome
    clock.advance(DEDUPE_TTL_MS - 1)
    expect(table.run(R, effect).repeat).toBe(true)
    clock.advance(1) // exactly 10 min: the entry is gone
    expect(table.run(R, effect).repeat).toBe(false)
    expect(effects).toBe(2)
  })

  it('[ADR-003] the Scheduler sweep drops a settled entry at 10 minutes with no repeat asking', async () => {
    const clock = new FakeClock()
    const table = new RequestTable<string>({ clock, scheduler: new FakeScheduler(clock) })

    await table.run(R, () => Promise.resolve('done')).outcome
    expect(table.size()).toBe(1)
    clock.advance(DEDUPE_TTL_MS - 1)
    expect(table.size()).toBe(1)
    clock.advance(1)
    expect(table.size()).toBe(0)
  })

  it('[ADR-003, FM-034] a repeat while the first is in flight joins it: one effect, one outcome', async () => {
    const clock = new FakeClock()
    const table = new RequestTable<string>({ clock, scheduler: new FakeScheduler(clock) })
    const gate = deferred<string>()
    let effects = 0
    const effect = (): Promise<string> => {
      effects += 1
      return gate.promise
    }

    const first = table.run(R, effect)
    const repeat = table.run(R, effect)
    expect(repeat.repeat).toBe(true)
    gate.resolve('settled')
    expect(await Promise.all([first.outcome, repeat.outcome])).toEqual(['settled', 'settled'])
    expect(effects).toBe(1)
  })

  it('[ADR-003] the in-flight time does not count: the 10 minutes start at settlement', async () => {
    const clock = new FakeClock()
    const table = new RequestTable<string>({ clock, scheduler: new FakeScheduler(clock) })
    const gate = deferred<string>()

    const first = table.run(R, () => gate.promise)
    clock.advance(DEDUPE_TTL_MS + 5) // in flight for longer than the window
    gate.resolve('late')
    await first.outcome
    clock.advance(DEDUPE_TTL_MS - 1)
    expect(table.run(R, () => Promise.resolve('again')).repeat).toBe(true)
  })

  it('[ADR-003] an effect that rejects is not remembered, so its requestId can run again', async () => {
    const clock = new FakeClock()
    const table = new RequestTable<string>({ clock, scheduler: new FakeScheduler(clock) })
    let reject!: (error: Error) => void
    const failing = new Promise<string>((_, r) => (reject = r))

    const first = table.run(R, () => failing)
    const joined = table.run(R, () => Promise.resolve('never'))
    expect(joined.repeat).toBe(true)
    reject(new Error('boom'))
    await expect(first.outcome).rejects.toThrow('boom')
    await expect(joined.outcome).rejects.toThrow('boom')
    expect(table.size()).toBe(0)
    expect(table.run(R, () => Promise.resolve('ok')).repeat).toBe(false)
  })

  it('[ADR-003] a new table starts empty: nothing survives the process', async () => {
    const clock = new FakeClock()
    const scheduler = new FakeScheduler(clock)
    const previous = new RequestTable<string>({ clock, scheduler })
    await previous.run(R, () => Promise.resolve('a')).outcome
    expect(previous.run(R, () => Promise.resolve('a')).repeat).toBe(true)

    const next = new RequestTable<string>({ clock, scheduler })
    expect(next.size()).toBe(0)
    expect(next.run(R, () => Promise.resolve('b')).repeat).toBe(false)
  })
})
