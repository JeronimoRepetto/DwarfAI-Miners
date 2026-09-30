import { describe } from 'vitest'
import { runSchedulerContract } from '../testing/scheduler.contract'
import { FakeClock } from './FakeClock'
import { FakeScheduler } from './FakeScheduler'

describe('FakeScheduler', () => {
  runSchedulerContract(({ onTaskError }) => {
    const clock = new FakeClock()
    const scheduler = new FakeScheduler(clock, { onTaskError })
    return { scheduler, advance: (ms) => clock.advance(ms) }
  })
})
