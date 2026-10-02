import { InMemoryCapabilityRecordStore } from '../ports/fakes/InMemoryCapabilityRecordStore'
import { runCapabilityRecordStoreContract } from './capabilityRecordStore.contract'

runCapabilityRecordStoreContract('InMemoryCapabilityRecordStore', () => {
  const store = new InMemoryCapabilityRecordStore()
  return { store, heldVersions: (id) => store.versions(id) }
})
