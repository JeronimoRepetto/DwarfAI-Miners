// layer: L3
// The SessionStarter bridge passes the launching module's `runSessionStarterContract` (16 §4.5,
// §2.8; 17 §1.3), over a scripted driver behind the suppliers `DriverRegistry` and the
// `SessionChannels` read of its early window.
import type { ProviderId } from '../../kernel/domain/values'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { ScriptedDriver } from '../../modules/launching/testing/ScriptedDriver'
import { runSessionStarterContract } from '../../modules/launching/testing/sessionStarter.contract'
import { createSessionStarter } from './sessionStarter'

runSessionStarterContract('the SessionStarter bridge', () => {
  const clock = new FakeClock(1_790_000_000_000)
  const scheduler = new FakeScheduler(clock)
  const providerId = 'contract' as ProviderId
  const scripted = new ScriptedDriver({ providerId, label: 'Contract tool', clock, scheduler })
  return {
    starter: createSessionStarter({
      registry: scripted.registry,
      sessions: scripted.sessions,
      clock,
      scheduler
    }),
    clock,
    providerId,
    arrange: (script) => scripted.arrange(script)
  }
})
