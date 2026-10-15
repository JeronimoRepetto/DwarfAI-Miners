// `RunDirCredentialFileStore` (owner amendment N (AMENDMENT-14, OQ-85), 2026-10-15, A14-04;
// ADR-013 item 3; C-13, C-15): the per-launch delegation credential files,
// `<hostDataDir>/run/mcp/<launchId>.cred`.
//
// - `write` creates `run/mcp/` `0700` when missing and narrows it to `0700` when it exists, then
//   creates the file exclusively (`wx`) with mode `0600`: a file already there is `'exists'` and is
//   never overwritten, and a link planted at the path fails the create instead of being written
//   through. The credential is written and the file closed; nothing here logs it. A write or close
//   that fails after the create deletes the partial file before the failure is reported.
// - On Windows the modes do nothing: the file inherits the owner-only protected DACL the boot puts
//   on the Host data directory (owner amendment of 2026-10-01, ISSUE-041; SP-05 run\ row), as
//   `ui.token` and `host.identity` do. The OS lane proves both (credentialFile.os.test.ts).
// - `remove` of a missing file succeeds; `list` gives the launch ids of the `.cred` files present
//   (a missing directory lists nothing).
// - OS failures cross the port as `FsError` (the kernel's mapping, `fsErrorOf`), never a message.
import { chmod, mkdir, open, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { HostInvariantError } from '../../../../kernel/domain/errors'
import type { LaunchId, Result } from '../../../../kernel/domain/values'
import type { FsError } from '../../../../kernel/ports/fileSystem'
import { fsErrorOf } from '../../../../platform/fs/NodeFs'
import type { CredentialFileStore } from '../../ports/delegationStores'

const CREDENTIAL_DIR_MODE = 0o700
const CREDENTIAL_FILE_MODE = 0o600
const SUFFIX = '.cred'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export class RunDirCredentialFileStore implements CredentialFileStore {
  private readonly dir: string

  private readonly openFile: typeof open

  /** `open` defaults to `fs/promises.open`; a test replaces it to fail a write part-way. */
  constructor(options: { hostDataDir: string; open?: typeof open }) {
    this.dir = join(options.hostDataDir, 'run', 'mcp')
    this.openFile = options.open ?? open
  }

  async write(
    launchId: LaunchId,
    credential: string
  ): Promise<Result<{ path: string }, 'exists' | FsError>> {
    const path = this.pathOf(launchId)
    try {
      await mkdir(this.dir, { recursive: true, mode: CREDENTIAL_DIR_MODE })
      await chmod(this.dir, CREDENTIAL_DIR_MODE)
      const file = await this.openFile(path, 'wx', CREDENTIAL_FILE_MODE)
      try {
        await file.writeFile(credential, 'utf8')
        await file.close()
      } catch (error) {
        // The file is ours (the exclusive create succeeded) but incomplete: close it if it is
        // still open and delete it, so no partial credential stays on disk.
        await file.close().catch(() => undefined)
        await rm(path, { force: true }).catch(() => undefined)
        throw error
      }
      return { ok: true, value: { path } }
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'EEXIST') {
        return { ok: false, error: 'exists' }
      }
      return { ok: false, error: fsErrorOf(error) }
    }
  }

  async remove(launchId: LaunchId): Promise<void> {
    await rm(this.pathOf(launchId), { force: true })
  }

  async list(): Promise<LaunchId[]> {
    let names: string[]
    try {
      names = await readdir(this.dir)
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'ENOENT') return []
      throw error
    }
    return names
      .filter((name) => name.endsWith(SUFFIX))
      .map((name) => name.slice(0, -SUFFIX.length) as LaunchId)
      .sort()
  }

  /** A launch id is a UUID (09 `launches.id`), so a file name never leaves `run/mcp/`. */
  private pathOf(launchId: LaunchId): string {
    if (!UUID.test(launchId))
      throw new HostInvariantError('a credential file is named by a launch id')
    return join(this.dir, `${launchId}${SUFFIX}`)
  }
}
