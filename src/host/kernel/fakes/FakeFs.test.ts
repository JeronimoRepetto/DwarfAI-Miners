import { describe } from 'vitest'
import { runFileSystemContract, runFileSystemFaultContract } from '../testing/fileSystem.contract'
import { FakeFs } from './FakeFs'

describe('FakeFs', () => {
  const makeSubject = (): {
    fs: FakeFs
    pathOf: (...segments: string[]) => string
    seed: (path: string, content: string) => Promise<void>
    scriptFault: FakeFs['scriptFault']
  } => {
    const fs = new FakeFs()
    return {
      fs,
      pathOf: (...segments) => ['/fake-root', ...segments].join('/'),
      seed: async (path, content) => fs.addFile(path, content),
      scriptFault: (path, fault) => fs.scriptFault(path, fault)
    }
  }

  runFileSystemContract(makeSubject)
  runFileSystemFaultContract(makeSubject)
})
