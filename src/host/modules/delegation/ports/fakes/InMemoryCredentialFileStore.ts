// The CredentialFileStore double (owner amendment N (AMENDMENT-14, OQ-85), 2026-10-15, A14-04:
// `InMemoryCredentialFileStore`). Never imported by production code (R14).
//
// It keeps the run-directory adapter's rules, held equal by runCredentialFileStoreContract: one
// file per launch at `<hostDataDir>/run/mcp/<launchId>.cred`, created exclusively (`'exists'`,
// never overwritten), `remove` of a missing file succeeds, `list` by launch id. `failNextWrite`
// lets a test make the next write fail as a full disk would.
import type { LaunchId, Result } from '../../../../kernel/domain/values'
import type { FsError } from '../../../../kernel/ports/fileSystem'
import type { CredentialFileStore } from '../delegationStores'

export class InMemoryCredentialFileStore implements CredentialFileStore {
  private readonly files = new Map<LaunchId, string>()
  private failure: FsError | null = null

  constructor(private readonly hostDataDir = '/host-data') {}

  async write(
    launchId: LaunchId,
    credential: string
  ): Promise<Result<{ path: string }, 'exists' | FsError>> {
    if (this.failure !== null) {
      const error = this.failure
      this.failure = null
      return { ok: false, error }
    }
    if (this.files.has(launchId)) return { ok: false, error: 'exists' }
    this.files.set(launchId, credential)
    return { ok: true, value: { path: this.pathOf(launchId) } }
  }

  async remove(launchId: LaunchId): Promise<void> {
    this.files.delete(launchId)
  }

  async list(): Promise<LaunchId[]> {
    return [...this.files.keys()].sort()
  }

  /** The file at `path`, or null. */
  read(path: string): string | null {
    const launchId = [...this.files.keys()].find((id) => this.pathOf(id) === path)
    return launchId === undefined ? null : (this.files.get(launchId) ?? null)
  }

  /** Every credential the double holds, serialized, to prove where a value went. */
  contents(): string {
    return JSON.stringify([...this.files.values()])
  }

  /** The next `write` fails with `error` and writes nothing. */
  failNextWrite(error: FsError): void {
    this.failure = error
  }

  private pathOf(launchId: LaunchId): string {
    return `${this.hostDataDir}/run/mcp/${launchId}.cred`
  }
}
