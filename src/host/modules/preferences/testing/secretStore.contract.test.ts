import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe } from 'vitest'
import { FakeSecretStore } from '../ports/fakes/FakeSecretStore'
import { runSecretStoreContract } from './secretStore.contract'

// L3 (17 §1.3): the double runs the same contract as `OsKeyringSecretStore`. It has no log, and its
// data directories are empty temporary folders that must stay empty.
describe('FakeSecretStore', () => {
  runSecretStoreContract((backend) => {
    const store = new FakeSecretStore()
    store.setBackend(backend)
    const dataDirs = [
      mkdtempSync(join(tmpdir(), 'dwarfai-host-')),
      mkdtempSync(join(tmpdir(), 'dwarfai-ui-'))
    ]
    return {
      store,
      logText: () => '',
      dataDirs,
      dispose: () => {
        for (const dir of dataDirs) rmSync(dir, { recursive: true, force: true })
      }
    }
  })
})
