import { runSingleInstanceLockContract } from '../singleInstanceLock.contract'
import { FakeSingleInstanceLock } from './FakeSingleInstanceLock'

runSingleInstanceLockContract('FakeSingleInstanceLock', ({ holdsLock }) => {
  const lock = new FakeSingleInstanceLock(!holdsLock)
  return { lock, launchAgain: () => lock.launchAgain() }
})
