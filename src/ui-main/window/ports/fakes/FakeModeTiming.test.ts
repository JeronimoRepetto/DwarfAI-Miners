import { runModeTimingContract } from '../modeTiming.contract'
import { FakeModeTiming } from './FakeModeTiming'

runModeTimingContract('FakeModeTiming', () => {
  const timing = new FakeModeTiming()
  return { timing, elapse: (ms) => timing.advance(ms) }
})
