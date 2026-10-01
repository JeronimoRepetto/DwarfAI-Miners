import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe } from 'vitest'
import { runLogFilesContract } from '../testing/logFiles.contract'
import { NodeLogFiles } from './NodeLogFiles'

describe('NodeLogFiles (the real LogFiles over a temporary folder)', () => {
  const roots: string[] = []
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  runLogFilesContract('NodeLogFiles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dwarfai-ui-logfiles-'))
    roots.push(root)
    return {
      files: new NodeLogFiles(),
      root,
      plantOtherFile: (dir, name) => writeFile(join(dir, name), 'not a segment\n')
    }
  })
})
