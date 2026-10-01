// layer: L3
import { describe } from 'vitest'
import { runUiPreferenceStoreContract } from '../../testing/uiPreferenceStore.contract'
import {
  createInMemoryUiPreferenceStorage,
  InMemoryUiPreferenceStore
} from './InMemoryUiPreferenceStore'

describe('InMemoryUiPreferenceStore', () => {
  runUiPreferenceStoreContract(() => {
    const storage = createInMemoryUiPreferenceStorage()
    return {
      open: () => new InMemoryUiPreferenceStore(storage),
      corrupt: (key) => storage.corrupt.add(key),
      interruptNextSave: () => {
        storage.interruptNextSave = true
      },
      logged: () => storage.logged
    }
  })
})
