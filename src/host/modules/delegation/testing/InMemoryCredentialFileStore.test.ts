import { describe } from 'vitest'
import { InMemoryCredentialFileStore } from '../ports/fakes/InMemoryCredentialFileStore'
import { runCredentialFileStoreContract } from './credentialFileStore.contract'

// L3 (17 §1.3): the double runs the same contract as the run-directory adapter.
describe('InMemoryCredentialFileStore', () => {
  runCredentialFileStoreContract(() => {
    const store = new InMemoryCredentialFileStore()
    return { store, read: (path) => store.read(path), dispose: () => undefined }
  })
})
