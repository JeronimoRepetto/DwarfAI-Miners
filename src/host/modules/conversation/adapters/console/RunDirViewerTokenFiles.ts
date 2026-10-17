// The per-view token files of the console viewer (ADR-003 item 12, frozen; ADR-031 item 2):
// `<hostDataDir>/run/viewers/<viewId>.token`, the delegation credential files' layout and rules
// (delegation/adapters/fs/RunDirCredentialFileStore.ts) for another folder.
//
// - `write` creates `run/viewers/` `0700` when missing and narrows it to `0700` when it exists, then
//   creates the file exclusively (`wx`) with mode `0600`: a file already there is never
//   overwritten, and a link planted at the path fails the create instead of being written through.
//   The file holds what viewer/viewerTokenFile.ts formats (the token and its dwarfId). A write that fails after the create
//   deletes the partial file before the failure is reported. Nothing here logs the token.
// - On Windows the modes do nothing: the file inherits the owner-only protected DACL the boot puts
//   on the Host data directory (SP-05 run\ row), as `ui.token` and the delegation credentials do.
// - The viewer reads and deletes its file before its `hello`; `remove` drops the file of a token
//   that expired unused, and `sweep` removes every leftover at boot (ADR-015 item 6).
import { chmod, mkdir, open, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { HostInvariantError } from '../../../../kernel/domain/errors'

const VIEWER_DIR_MODE = 0o700
const VIEWER_FILE_MODE = 0o600
/** The token file's suffix, after its viewId. */
export const VIEWER_TOKEN_SUFFIX = '.token'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** `<hostDataDir>/run/viewers`, where every per-view token file lives. */
export function viewerTokenDir(hostDataDir: string): string {
  return join(hostDataDir, 'run', 'viewers')
}

export class RunDirViewerTokenFiles {
  private readonly dir: string

  constructor(options: { hostDataDir: string }) {
    this.dir = viewerTokenDir(options.hostDataDir)
  }

  /** Writes the token file of `viewId` (its `content`) and answers the file's path. */
  async write(viewId: string, content: string): Promise<string> {
    const path = this.pathOf(viewId)
    await mkdir(this.dir, { recursive: true, mode: VIEWER_DIR_MODE })
    await chmod(this.dir, VIEWER_DIR_MODE)
    const file = await open(path, 'wx', VIEWER_FILE_MODE)
    try {
      await file.writeFile(content, 'utf8')
      await file.close()
    } catch (error) {
      await file.close().catch(() => undefined)
      await rm(path, { force: true }).catch(() => undefined)
      throw error
    }
    return path
  }

  /** Removes the file of `viewId`; a missing file is fine. */
  async remove(viewId: string): Promise<void> {
    await rm(this.pathOf(viewId), { force: true })
  }

  /** Removes every token file left in the folder (boot, ADR-015 item 6); a missing folder is fine. */
  async sweep(): Promise<void> {
    let names: string[]
    try {
      names = await readdir(this.dir)
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'ENOENT') return
      throw error
    }
    for (const name of names) {
      if (name.endsWith(VIEWER_TOKEN_SUFFIX)) {
        await rm(join(this.dir, name), { force: true })
      }
    }
  }

  /** A viewId is a UUID, so a file name never leaves `run/viewers/`. */
  private pathOf(viewId: string): string {
    if (!UUID.test(viewId))
      throw new HostInvariantError('a viewer token file is named by a view id')
    return join(this.dir, `${viewId}${VIEWER_TOKEN_SUFFIX}`)
  }
}
