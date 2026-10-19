import { runIdentityProbeContract } from '../testing/identityProbe.contract'
import { FakeIdentityProbe } from './FakeIdentityProbe'

runIdentityProbeContract('FakeIdentityProbe', () => {
  const live = { pid: 4242, processStartTimeMs: 1_759_395_600_000 }
  return Promise.resolve({ probe: new FakeIdentityProbe().alive(live).probe, live, gonePid: 4343 })
})
