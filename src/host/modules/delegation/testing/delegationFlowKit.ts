// The delegation module's doubles for a Host wiring flow (17 §1.2): the wiring reaches a module
// only through its index or its `testing/` folder (R15), so this file hands over the in-memory
// stores (16 §4.8 doubles) and a `DelegationLifecycle` composed over them with a test minter.
// Test-only: production code never imports it (R14).
import type { HostEpoch } from '../../../kernel/domain/values'
import type { Clock } from '../../../kernel/ports/clock'
import type { DiagnosticsLog } from '../../../kernel/ports/diagnosticsLog'
import type { IdGenerator } from '../../../kernel/ports/idGenerator'
import { RecordingEventBus } from '../../../kernel/fakes/RecordingEventBus'
import type { PreferencesQueries } from '../../preferences'
import { DelegationLifecycleService } from '../application/delegationLifecycle'
import type { DelegationLifecycleEvent } from '../domain/events'
import type { DelegationTicketStore, DelegationTokenStore } from '../ports/delegationStores'
import { InMemoryCredentialFileStore } from '../ports/fakes/InMemoryCredentialFileStore'
import { drawCredential, hashOf } from './drawCredential'

export { InMemoryDelegationTicketStore } from '../ports/fakes/InMemoryDelegationTicketStore'
export { InMemoryDelegationTokenStore } from '../ports/fakes/InMemoryDelegationTokenStore'
export { FakeSubtaskRouter } from '../ports/fakes/FakeSubtaskRouter'
export { FakeWorkerLauncher } from '../ports/fakes/FakeWorkerLauncher'
export { FakeParentDeliverer } from '../ports/fakes/FakeParentDeliverer'

/** A `DelegationLifecycle` over the given stores, in-memory credential files and a test minter. */
export function inMemoryDelegationLifecycle(deps: {
  tokens: DelegationTokenStore
  tickets: DelegationTicketStore
  clock: Clock
  ids: IdGenerator
  hostEpoch: HostEpoch
  log: DiagnosticsLog
  preferences: Pick<PreferencesQueries, 'get'>
}) {
  const files = new InMemoryCredentialFileStore()
  const bus = new RecordingEventBus<DelegationLifecycleEvent>()
  const lifecycle = new DelegationLifecycleService({
    ...deps,
    files,
    transactions: { inTransaction: (work) => work() },
    bus,
    mintCredential: () => {
      const value = drawCredential()
      return { value, sha256: hashOf(value) }
    },
    appPaths: { execPath: '/opt/dwarfai/versions/0.0.0/DwarfAI-Miners' },
    relayEntryArgs: ['--dwarfai-relay-entry']
  })
  return { lifecycle, files, bus }
}
