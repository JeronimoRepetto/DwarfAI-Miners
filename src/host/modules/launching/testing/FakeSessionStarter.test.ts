// layer: L2
// The SessionStarter double passes the same contract as the real bridge (16 §2.8; 17 §1.3).
import type { ProviderId } from '../../../kernel/domain/values'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../../kernel/fakes/FakeScheduler'
import { FakeSessionStarter } from './FakeSessionStarter'
import { runSessionStarterContract } from './sessionStarter.contract'

runSessionStarterContract('FakeSessionStarter', () => {
  const clock = new FakeClock(1_790_000_000_000)
  const starter = new FakeSessionStarter({ clock, scheduler: new FakeScheduler(clock) })
  return {
    starter,
    clock,
    providerId: 'contract' as ProviderId,
    arrange: (script) => starter.arrange(script)
  }
})
