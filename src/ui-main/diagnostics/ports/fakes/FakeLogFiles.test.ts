import { join } from 'node:path'
import { describe } from 'vitest'
import { runLogFilesContract } from '../../testing/logFiles.contract'
import { FakeLogFiles } from './FakeLogFiles'

describe('FakeLogFiles (16 §2.8: the double runs the adapter contract)', () => {
  runLogFilesContract('FakeLogFiles', async () => {
    const files = new FakeLogFiles()
    const root = join('/', 'fake-root')
    await files.makeDir(root)
    return {
      files,
      root,
      plantOtherFile: async (dir, name) => files.plant(join(dir, name), 'not a segment\n')
    }
  })
})
