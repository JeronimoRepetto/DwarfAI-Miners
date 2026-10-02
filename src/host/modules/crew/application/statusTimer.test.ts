import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../../kernel/fakes/FakeScheduler'
import { RecordingEventBus } from '../../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import type { DwarfId } from '../../../kernel/domain/values'
import type { Clock } from '../../../kernel/ports/clock'
import type { Scheduler } from '../../../kernel/ports/scheduler'
import type { DwarfStatusChanged } from '../domain/events'
import type { DwarfStatus, StatusFacts } from '../domain/status'
import {
  arrivalFacts,
  askClosed,
  askOpened,
  departed,
  otherActivity,
  turnEnded,
  turnStarted
} from '../domain/statusFacts'
import { StatusTimer } from './statusTimer'

const T0 = 1_790_000_000_000
const SEC = 1_000
const D1 = '01890a5d-ac96-774b-bcce-b302099ad001' as DwarfId
const D2 = '01890a5d-ac96-774b-bcce-b302099ad002' as DwarfId
const STATUSES: readonly DwarfStatus[] = ['working', 'asking', 'idle', 'asleep']

/**
 * The wall clock the Host reads, over the monotonic FakeClock the scheduler runs on: `jump` moves
 * only the wall clock, as a system time change does (FM-113), while timers keep their own pace.
 */
class JumpingClock implements Clock {
  private offset = 0
  constructor(private readonly monotonic: FakeClock) {}
  now(): number {
    return this.monotonic.now() + this.offset
  }
  jump(ms: number): void {
    this.offset += ms
  }
}

/** Counts the wake-ups pending and fired, over the FakeScheduler. */
class CountingScheduler implements Scheduler {
  pending = 0
  fired = 0
  constructor(private readonly inner: Scheduler) {}
  after(ms: number, task: () => void): { cancel(): void } {
    this.pending += 1
    let live = true
    const handle = this.inner.after(ms, () => {
      live = false
      this.pending -= 1
      this.fired += 1
      task()
    })
    return {
      cancel: () => {
        if (live) this.pending -= 1
        live = false
        handle.cancel()
      }
    }
  }
}

function setup() {
  const monotonic = new FakeClock(T0)
  const clock = new JumpingClock(monotonic)
  const scheduler = new CountingScheduler(new FakeScheduler(monotonic))
  const bus = new RecordingEventBus<DwarfStatusChanged>()
  const timer = new StatusTimer({
    clock,
    scheduler,
    bus,
    ids: new SequenceIdGenerator(),
    hostEpoch: 'epoch-1'
  })
  const changes = () => bus.ofType('DwarfStatusChanged').map((e) => e.payload)
  return { monotonic, clock, scheduler, bus, timer, changes }
}

describe('the status timer (ADR-032 item 3; 16 §4.2 recordActivity / startAsking / stopAsking)', () => {
  it('[ADR-032] DwarfStatusChanged is published once per change and never for an unchanged status', () => {
    const { monotonic, clock, timer, changes, bus } = setup()
    let facts: StatusFacts = arrivalFacts(T0, 'idle')
    const commit = (next: StatusFacts) => {
      facts = next
      timer.factsChanged(D1, facts)
    }
    // The arrival itself is DwarfArrived's (machine 2): no status change is published for it.
    commit(facts)
    expect(timer.statusOf(D1)).toBe('idle')
    monotonic.advance(59_999)
    expect(changes()).toEqual([])
    monotonic.advance(1)
    expect(changes()).toEqual([{ dwarfId: D1, from: 'idle', to: 'asleep' }])
    monotonic.advance(10 * 60 * SEC)
    expect(changes()).toHaveLength(1)

    commit(otherActivity(facts, clock.now())) // S1.07 asleep → idle
    commit(otherActivity(facts, clock.now() + SEC)) // S1.06 idle → idle: nothing
    commit(turnStarted(facts, clock.now())) // S1.09 → working
    commit(otherActivity(facts, clock.now())) // working → working: nothing
    const askedAt = clock.now()
    commit(askOpened(facts, { kind: 'question', askedAt, state: 'open' }))
    commit(askOpened(facts, { kind: 'permission', askedAt, state: 'open' })) // queued: nothing
    commit(askClosed(facts, { kind: 'permission', askedAt })) // S1.15: nothing
    commit(askClosed(facts)) // S1.13 → working
    commit(turnEnded(facts, { at: clock.now(), reliability: 'reliable', cancelledFromApp: false }))
    expect(changes()).toEqual([
      { dwarfId: D1, from: 'idle', to: 'asleep' },
      { dwarfId: D1, from: 'asleep', to: 'idle' },
      { dwarfId: D1, from: 'idle', to: 'working' },
      { dwarfId: D1, from: 'working', to: 'asking', askedAt },
      { dwarfId: D1, from: 'asking', to: 'working' },
      { dwarfId: D1, from: 'working', to: 'idle' }
    ])
    // The envelope (08 §1.2): Host clock at publish, this boot's epoch.
    const last = bus.published.at(-1)
    expect(last).toMatchObject({
      type: 'DwarfStatusChanged',
      v: 1,
      at: clock.now(),
      hostEpoch: 'epoch-1'
    })

    // S1.20: after the departure no wake-up fires and nothing more is published.
    timer.departed(D1)
    monotonic.advance(10 * 60 * SEC)
    expect(changes()).toHaveLength(6)
    expect(timer.statusOf(D1)).toBeNull()
  })

  it('[NFR-TIM-04, INV-25] one wake-up per idle dwarf fires at idleSince + 60 000 ms, and activity before it cancels and reschedules it', () => {
    const { monotonic, scheduler, timer, changes } = setup()
    const facts = arrivalFacts(T0, 'idle')
    timer.factsChanged(D1, facts)
    timer.factsChanged(D2, arrivalFacts(T0, 'working'))
    expect(scheduler.pending).toBe(1) // only the idle dwarf has a wake-up
    monotonic.advance(30 * SEC)
    timer.factsChanged(D1, otherActivity(facts, T0 + 30 * SEC))
    expect(scheduler.pending).toBe(1) // cancelled and rescheduled, never two
    monotonic.advance(59_999)
    expect(changes()).toEqual([])
    monotonic.advance(1)
    expect(scheduler.fired).toBe(1)
    expect(scheduler.pending).toBe(0)
    expect(changes()).toEqual([{ dwarfId: D1, from: 'idle', to: 'asleep' }])
    expect(timer.statusOf(D2)).toBe('working')
  })

  it('[FM-113, CH-08] a FakeClock jump forward or backward only makes the idle-to-asleep wake-up fire earlier or later and never yields a status outside the four values', () => {
    // Backward: the wall clock goes back 10 s while idle; the wake-up re-evaluates and fires 10 s later.
    const back = setup()
    back.timer.factsChanged(D1, arrivalFacts(T0, 'idle'))
    back.monotonic.advance(20 * SEC)
    back.clock.jump(-10 * SEC)
    back.monotonic.advance(40 * SEC)
    expect(back.timer.statusOf(D1)).toBe('idle')
    expect(back.changes()).toEqual([])
    back.monotonic.advance(10 * SEC - 1)
    expect(back.changes()).toEqual([])
    back.monotonic.advance(1)
    expect(back.changes()).toEqual([{ dwarfId: D1, from: 'idle', to: 'asleep' }])

    // Forward: the wall clock jumps 30 s ahead; the next re-evaluation fires 30 s earlier.
    const ahead = setup()
    const facts = arrivalFacts(T0, 'idle')
    ahead.timer.factsChanged(D1, facts)
    ahead.clock.jump(30 * SEC)
    ahead.monotonic.advance(10 * SEC)
    // An ask opened and closed re-evaluates and reschedules from the jumped clock.
    const at = ahead.clock.now()
    ahead.timer.factsChanged(D1, askOpened(facts, { kind: 'question', askedAt: at, state: 'open' }))
    ahead.timer.factsChanged(D1, facts)
    ahead.monotonic.advance(20 * SEC - 1)
    expect(ahead.timer.statusOf(D1)).toBe('idle')
    ahead.monotonic.advance(1)
    expect(ahead.timer.statusOf(D1)).toBe('asleep')

    // A jump past the wake instant classifies at once: asleep, with no wake-up left behind.
    const far = setup()
    far.clock.jump(5 * 60 * SEC)
    far.timer.factsChanged(D1, arrivalFacts(T0, 'idle'))
    expect(far.timer.statusOf(D1)).toBe('asleep')
    expect(far.scheduler.pending).toBe(0)

    // Any mix of jumps: the status stays one of the four values.
    const mixed = setup()
    let f: StatusFacts = arrivalFacts(T0, 'idle')
    mixed.timer.factsChanged(D1, f)
    for (const [jump, step] of [
      [-90, 15],
      [45, 30],
      [-5, 61],
      [600, 1],
      [-700, 120]
    ] as const) {
      mixed.clock.jump(jump * SEC)
      mixed.monotonic.advance(step * SEC)
      f = otherActivity(f, mixed.clock.now())
      mixed.timer.factsChanged(D1, f)
      expect(STATUSES).toContain(mixed.timer.statusOf(D1))
      expect(mixed.scheduler.pending).toBeLessThanOrEqual(1)
    }
    for (const change of mixed.changes()) {
      expect(STATUSES).toContain(change.from)
      expect(STATUSES).toContain(change.to)
    }
  })

  it('[ADR-032] a Host restart recomputes every status from the persisted facts, publishes nothing and keeps the wake-up instant', () => {
    const before = setup()
    const persisted = [
      { dwarfId: D1, facts: arrivalFacts(T0, 'idle') },
      { dwarfId: D2, facts: departed(arrivalFacts(T0, 'idle')) }
    ]
    before.timer.factsChanged(D1, persisted[0]!.facts)
    before.monotonic.advance(20 * SEC)

    // A new Host at the same instant: no timer state carried over.
    const after = setup()
    after.monotonic.advance(20 * SEC)
    after.timer.recompute(persisted.slice(0, 1))
    expect(after.timer.statusOf(D1)).toBe(before.timer.statusOf(D1))
    expect(after.changes()).toEqual([])
    after.monotonic.advance(40 * SEC - 1)
    expect(after.changes()).toEqual([])
    after.monotonic.advance(1)
    expect(after.changes()).toEqual([{ dwarfId: D1, from: 'idle', to: 'asleep' }])
  })
})
