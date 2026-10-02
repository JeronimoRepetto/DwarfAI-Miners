import { runAutostartContract } from '../autostart.contract'
import { FakeAutostartPort } from './FakeAutostartPort'

runAutostartContract('FakeAutostartPort', () => {
  const autostart = new FakeAutostartPort()
  return {
    autostart,
    writes: () => autostart.writes,
    disableInOs: () => autostart.disableInOs(),
    refuseWrites: () => (autostart.refuse = 'always')
  }
})
