// The run folder's file store over node:fs (ADR-002 D3: `run/host.identity` is `0600`, written by
// temp + rename). The folder is created `0700` when missing, as the uiToken does for `ui.token`.
// The temporary sibling is created exclusively (`wx`) with mode `0600` in the same folder, so the
// rename never crosses a volume and the target is replaced in one step; a link planted at the
// temporary name fails the create instead of being written through. On Windows the modes do
// nothing and the file inherits the run folder's ACL (UNVERIFIED, SP-05).
import { randomUUID } from 'node:crypto'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { RunFileWriter } from './hostIdentityFile'

const RUN_DIR_MODE = 0o700
const RUN_FILE_MODE = 0o600

export class NodeRunFileWriter implements RunFileWriter {
  async writeAtomic(path: string, text: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: RUN_DIR_MODE })
    const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
    const file = await open(temp, 'wx', RUN_FILE_MODE)
    try {
      try {
        await file.writeFile(text, 'utf8')
        await file.sync()
      } finally {
        await file.close()
      }
      await rename(temp, path)
    } catch (error) {
      await rm(temp, { force: true })
      throw error
    }
  }

  async remove(path: string): Promise<void> {
    await rm(path, { force: true })
  }
}
