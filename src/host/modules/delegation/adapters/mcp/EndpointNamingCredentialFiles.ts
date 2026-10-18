// `EndpointNamingCredentialFiles` (ADR-013 items 2–3; foreman decision 2026-10-18, owner-approved
// in place of the rejected AMENDMENT-24): the `CredentialFileStore` the delegation lifecycle writes
// through, so each launch's credential file also names the MCP endpoint the Host bound
// (relay/credentialFileLayout.ts). The relay then reads the endpoint from the file instead of
// deriving it from an environment the provider may have trimmed (15 §4 gives the relay entry
// `ELECTRON_RUN_AS_NODE` and `DWARFAI_MCP_CREDENTIAL_FILE` only; Linux XDG_RUNTIME_DIR, CI run
// 39109490095).
//
// - `endpoint()` is read at each write: null until the MCP endpoint listens (or when it could not
//   be bound), and then the file holds the credential alone, the layout a relay derives from.
// - Everything else is the wrapped store's: path, exclusive create, `0600` in a `0700` dir, the
//   owner-only ACL on Windows, `remove`, `list`. Nothing here logs the content.
import type { LaunchId, Result } from '../../../../kernel/domain/values'
import type { FsError } from '../../../../kernel/ports/fileSystem'
import type { CredentialFileStore } from '../../ports/delegationStores'
import { credentialFileContent } from './relay/credentialFileLayout'

export class EndpointNamingCredentialFiles implements CredentialFileStore {
  constructor(
    private readonly files: CredentialFileStore,
    /** The path of the MCP endpoint the Host bound, or null while there is none. */
    private readonly endpoint: () => string | null
  ) {}

  write(
    launchId: LaunchId,
    credential: string
  ): Promise<Result<{ path: string }, 'exists' | FsError>> {
    return this.files.write(launchId, credentialFileContent(credential, this.endpoint()))
  }

  remove(launchId: LaunchId): Promise<void> {
    return this.files.remove(launchId)
  }

  list(): Promise<LaunchId[]> {
    return this.files.list()
  }
}
