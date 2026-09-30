import { describe } from 'vitest'
import { FakeFs } from '../../../kernel/fakes/FakeFs'
import { runLogDirectoryContract } from './logDirectory.contract'
import { FakeLogDirectory } from '../ports/fakes/FakeLogDirectory'

describe('FakeLogDirectory', () => {
  runLogDirectoryContract(() => {
    const fs = new FakeFs()
    return {
      directoryAt: (path) => new FakeLogDirectory(fs, path),
      pathOf: (...segments) => ['/fake-root', ...segments].join('/'),
      seed: async (path, content) => fs.addFile(path, content)
    }
  })
})
